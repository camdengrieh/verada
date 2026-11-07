#!/usr/bin/env bash
# Startup command of the Varada 1Claw runtime. The runtime clones this repository and runs
#   bash agents/runtime/start.sh
# from the clone. It installs what the curator skill and this server need, configures git for the
# audit-trail push when GITHUB_TOKEN is set, and starts the server (and the scheduler when
# SCHEDULER_ENABLED=true). Secrets come from the environment; nothing is printed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# Everything this script prints also goes to a file the placeholder serves at /startup-log, so
# startup can be followed over HTTP when the platform's logs are not available.
LOGF="$ROOT/.startup.log"; : > "$LOGF"
exec > >(tee -a "$LOGF" >&2) 2>&1
log() { echo "[start.sh $(date -u +%H:%M:%S)] $*"; }
# Containers may start without a writable HOME; git and npm both need one.
if [ -z "${HOME:-}" ] || [ ! -w "${HOME}" ]; then export HOME="$ROOT/.home"; mkdir -p "$HOME"; fi
log "repo $ROOT, node $(node --version), HOME $HOME"

# Hold the HTTP ports from the first second: Cloud Run's startup probe (TCP on the runtime's
# http_port) allows only a few minutes, and the installs below can take longer. Requests get a
# 503 "starting" until the real server replaces this.
STARTUP_LOG_FILE="$LOGF" node -e '
const http = require("http"), fs = require("fs");
const ports = [...new Set([Number(process.env.PORT) || 8080, Number(process.env.HTTP_PORT) || 8000])];
const tail = (n) => { try { return fs.readFileSync(process.env.STARTUP_LOG_FILE, "utf8").split("\n").slice(-n).join("\n"); } catch { return ""; } };
for (const p of ports) http.createServer((q, s) => {
  if (q.url.startsWith("/startup-log")) { s.writeHead(200, { "content-type": "text/plain" }); return s.end(tail(400)); }
  s.writeHead(503, { "retry-after": "30", "content-type": "application/json" });
  s.end(JSON.stringify({ ok: false, starting: true, log: tail(5).split("\n") }));
}).listen(p);
' &
HOLD=$!
log "placeholder listening (pid $HOLD)"

# If anything below fails, stay up so the logs can be read instead of crash-looping; the
# placeholder keeps answering 503.
trap 'log "startup failed at line $LINENO; sleeping so the logs stay readable"; sleep 3600' ERR

# This server (standalone package, its own lockfile): small, so it comes first.
log "npm ci (agents/runtime)"
(cd agents/runtime && (npm ci --no-audit --no-fund --loglevel=warn || { log "npm ci failed, trying npm install"; npm install --no-audit --no-fund --loglevel=warn; }))
log "npm ci done"

# The scheduler also needs the curator CLI (its workspace dependencies, not the whole monorepo)
# and Claude Code. The chat runtime needs neither.
if [ "${SCHEDULER_ENABLED:-false}" = "true" ]; then
  if ! command -v pnpm >/dev/null 2>&1; then corepack enable >/dev/null 2>&1 || npm install -g pnpm@10 >/dev/null; fi
  pnpm install --frozen-lockfile --filter "@varada/curator..." >/dev/null
  command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code >/dev/null
fi

# The skill commits its audit trail to claude/curation-<epoch> and pushes.
# GITHUB_TOKEN may arrive later (the server reads it from the vault), so the helper reads it at use time.
git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f' || log "git config failed (continuing)"
git config --global user.name "${GIT_AUTHOR_NAME:-varada-curator}" || true
git config --global user.email "${GIT_AUTHOR_EMAIL:-curators@varada.invalid}" || true

export REPO_DIR="$ROOT"
trap - ERR
kill "$HOLD" 2>/dev/null || true
wait "$HOLD" 2>/dev/null || true
log "starting server"
exec npm --prefix agents/runtime start
