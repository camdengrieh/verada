#!/usr/bin/env bash
# Startup command of the Varada 1Claw runtime. The runtime clones this repository and runs
#   bash agents/runtime/start.sh
# from the clone. It installs what the curator skill and this server need, configures git for the
# audit-trail push when GITHUB_TOKEN is set, and starts the server (and the scheduler when
# SCHEDULER_ENABLED=true). Secrets come from the environment; nothing is printed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# The curator CLI and its workspace dependencies (not the whole monorepo).
if ! command -v pnpm >/dev/null 2>&1; then corepack enable >/dev/null 2>&1 || npm install -g pnpm@10 >/dev/null; fi
pnpm install --frozen-lockfile --filter "@varada/curator..." >/dev/null

# This server (standalone package, its own lockfile).
(cd agents/runtime && npm ci --no-audit --no-fund >/dev/null)

# Claude Code runs the curator skill. The claude-code template ships it; other templates install it.
if [ "${SCHEDULER_ENABLED:-false}" = "true" ] && ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code >/dev/null
fi

# The skill commits its audit trail to claude/curation-<epoch> and pushes.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
  git config --global user.name "${GIT_AUTHOR_NAME:-varada-curator}"
  git config --global user.email "${GIT_AUTHOR_EMAIL:-curators@varada.invalid}"
fi

export REPO_DIR="$ROOT"
exec npm --prefix agents/runtime start
