# Varada agent runtime (1Claw)

One always-on container on the 1Claw runtime that Pro includes (small or medium, no hour cap). It
does two jobs:

1. **Scheduler.** Every 5 minutes it asks `varada-curator curators` for today's rotation. When an
   agent's daily time has come (06:00-10:30 UTC) and the rotation gives it a run today, it starts
   one Claude Code run of the curator skill:
   `claude -p "run the curator skill for agent <name>"`, with that agent's `ONECLAW_AGENT_ID` and
   `ONECLAW_API_KEY`. Runs are sequential (one agent signs at a time), time out after
   `CURATOR_TIMEOUT_MINUTES`, and are recorded in `STATE_FILE` so an agent runs at most once a day.
   Off by default (`SCHEDULER_ENABLED=false`) until the contracts are deployed and the agents are
   registered.
2. **Public chat.** `POST /chat/<cause>` lets anyone ask any of the twenty causes about its latest
   report, ranked charities and donors. It is stateless: the browser sends the conversation
   (at most 20 turns, 4000 characters each). The server adds the cause's public data from the
   indexer (cached `CONTEXT_TTL_SECONDS`) and asks Claude, so any number of users can chat with
   any cause and no per-user 1Claw resources are needed.

| Route | |
|---|---|
| `GET /health` | `{ ok, causes, scheduler: { lastRuns, error } }` |
| `GET /causes` | The twenty cause labels |
| `POST /chat/:cause` | Body `{ messages: [{ role: "user" \| "assistant", content }] }`. Returns `{ cause, reply, truncated }`, or `400 invalid_request`, `404 unknown_cause`, `429 rate_limited` (with `retry-after`), `503 data_unavailable` / `busy`, `502 upstream_error` |

## Chat model and limits

- Model `CHAT_MODEL` (default `claude-opus-5-5`) at effort `CHAT_EFFORT` (default `low`), at most
  4096 output tokens per answer.
- Server-side refusal fallback is on (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`). A refusal that the fallback does not rescue gets a fixed
  polite reply.
- The prompt is the fixed instructions, then the cause's data, with one cache breakpoint after the
  data. Repeated questions about the same cause read the cached prefix.
- Per client IP: `CHAT_RATE_PER_MINUTE` (6) and `CHAT_RATE_PER_DAY` (60). The IP is the first
  `X-Forwarded-For` hop set by 1Claw's proxy.
- Browsers: CORS allows only `CHAT_ALLOWED_ORIGINS` (default `https://varada.eth.limo,https://varada.eth.link`).
- The data in the prompt includes text written from news. The instructions treat it as data,
  never as instructions. The chat has no tools, so it cannot sign, send or fetch anything.

## Environment

| Variable | Kind | |
|---|---|---|
| `INDEXER_URL` | Plain, required | Indexer base URL (public `/api/agents/*` routes) |
| `ANTHROPIC_API_KEY` | Vault secret | For the chat and for Claude Code |
| `SCHEDULER_ENABLED` | Plain | `true` to run the curators here |
| `ONECLAW_KEYS_VAULT_ID` | Plain | The vault `varada-curator-api-keys`; the runtime's bound agent needs read access to it |
| `ONECLAW_AGENT_TOKEN` | Minted by 1Claw | Reads the agents' API keys from that vault |
| `GITHUB_TOKEN` | Vault secret | Contents write on the repository, for the skill's audit-trail push |
| `CURATOR_REGISTRY_ADDRESS`, `PUBLISHER_URL`, `CATALOG_SOURCE`, `ETH_RPC_URL` | Plain | Passed through to the curator runs (see `agents/README.md`) |
| `CURATOR_COMMAND` | Plain, optional | Default `claude -p {prompt} --output-format json --allowedTools Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Task` |
| `CHAT_MODEL`, `CHAT_EFFORT`, `CHAT_RATE_PER_MINUTE`, `CHAT_RATE_PER_DAY`, `CHAT_ALLOWED_ORIGINS`, `CONTEXT_TTL_SECONDS`, `CURATOR_TIMEOUT_MINUTES`, `STATE_FILE`, `PORT` | Plain, optional | See `src/config.ts` |

A curator run inherits the container environment except the runtime's own 1Claw token, the key
vault id, other agents' keys and the chat settings. It gets exactly one agent's key.

## Provisioning on 1Claw

1. Secrets: add `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` to the vault in the 1Claw dashboard. Never
   paste them into a chat or a file.
2. Bind the runtime to one of the ten agents and grant that agent read on `varada-curator-api-keys`.
   Every agent's key is then readable inside this one container. That is inherent in running all
   ten from one runtime; the on-chain limits (per-cause signer checks, `maxGivePerEpoch`) and
   each agent's 1Claw guardrails still apply to every key.
3. Create the runtime:
   - template `claude-code`, preset `medium` (Claude Code plus the pnpm install need more than
     512 MB);
   - source repo `https://github.com/camdengrieh/verada`, branch `main`;
   - startup command `bash agents/runtime/start.sh`;
   - `expose_http: true`, `http_port: 8000`, `inbound_auth: public`, slug e.g. `varada-agents`
     (served at `https://varada-agents.run.1claw.co`);
   - no `schedule`: always on, since the included runtime has no hour cap;
   - `env_public` with the plain variables above.
4. Check `GET /health`, then a chat. Turn on `SCHEDULER_ENABLED` after the agents are registered on
   chain and their 1Claw signing is on (`agents/README.md` §1-2).

Local run: `cd agents/runtime && npm ci && INDEXER_URL=... ANTHROPIC_API_KEY=... npm start`.
Tests: `npm test`.
