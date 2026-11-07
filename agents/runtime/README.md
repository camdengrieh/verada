# Varada agent runtime (1Claw)

One image, two jobs, **two separate runtimes**:

| Runtime | Job | HTTP | Secrets it can read |
|---|---|---|---|
| `varada-agents` (the Pro included runtime) | public chat | `inbound_auth: public` | `runtime/anthropic-api-key` only |
| `varada-scheduler` (a small add-on) | the curator scheduler | none (`expose_http: false`) | the agents' key vault + `runtime/**` |

The scheduler reads every agent's signing key, so it never runs where HTTP is open to the public:
an exploit of the chat server would otherwise reach all ten keys. The server enforces this
(`INBOUND_AUTH=public`, set by 1Claw, blocks `SCHEDULER_ENABLED`; `/health` reports
`scheduler.blocked`). Each agent's 1Claw guardrails and the on-chain caps (per-cause signer checks,
`maxGivePerEpoch`, 5 transactions a day) bound what a stolen key could do, but the split keeps the
keys off the public surface in the first place.

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
| `INDEXER_URL` | Plain | Indexer base URL (public `/api/agents/*` routes). Until it is set, the chat says nothing has been published yet |
| `ANTHROPIC_API_KEY` | Vault secret | For the chat and for Claude Code |
| `SCHEDULER_ENABLED` | Plain | `true` to run the curators here |
| `AGENTS_VAULT_ID` | Plain | The vault `varada-curator-api-keys`; the runtime's bound agent needs read access to it |
| `ONECLAW_AGENT_TOKEN` | Minted by 1Claw | Reads the agents' API keys from that vault |
| `GITHUB_TOKEN` | Vault secret | Contents write on the repository, for the skill's audit-trail push |
| `CURATOR_REGISTRY_ADDRESS`, `PUBLISHER_URL`, `CATALOG_SOURCE`, `ETH_RPC_URL` | Plain | Passed through to the curator runs (see `agents/README.md`) |
| `CURATOR_COMMAND` | Plain, optional | Default `claude -p {prompt} --output-format json --allowedTools Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Task` |
| `CHAT_MODEL`, `CHAT_EFFORT`, `CHAT_RATE_PER_MINUTE`, `CHAT_RATE_PER_DAY`, `CHAT_ALLOWED_ORIGINS`, `CONTEXT_TTL_SECONDS`, `CURATOR_TIMEOUT_MINUTES`, `STATE_FILE`, `PORT` / `HTTP_PORT` (the server listens on both: Cloud Run's `PORT`, 8080, and the runtime's `http_port`, default 8000) | Plain, optional | See `src/config.ts` |

A curator run inherits the container environment except the runtime's own 1Claw token, the key
vault id, other agents' keys and the chat settings. It gets exactly one agent's key.

## Provisioning on 1Claw

Secrets live in the `varada-curators` vault as **secrets** (vault env vars do not reach the
container): `runtime/anthropic-api-key` and `runtime/github-token`. 1Claw rejects `env_public`
keys that look sensitive, so the vault ids are passed as `RUNTIME_VAULT_ID` / `AGENTS_VAULT_ID`.

**Chat runtime** (done 2026-11-07, id `ba1b4137-…`): template `claude-code`, preset `medium`,
source repo `https://github.com/camdengrieh/verada`, startup command
`git fetch --depth 1 origin agents/runtime && git checkout -q FETCH_HEAD && bash agents/runtime/start.sh`,
`expose_http: true`, `inbound_auth: public`, slug `varada-agents`
(`https://varada-agents.run.1claw.co`), no `schedule` (always on, no hour cap), `env_public`
`SCHEDULER_ENABLED=false`, `RUNTIME_VAULT_ID`, `CHAT_ALLOWED_ORIGINS`. Bound to the `relief` agent,
which has one policy: read on `runtime/**` in `varada-curators`. Nothing grants it the key vault.

**Scheduler** (once the agents are registered on chain and signing is on), one of two ways:

- **Claude scheduled routines, one per agent** (`agents/README.md` §4). Each run receives only its
  own agent's key as a network secret, so no machine ever holds more than one key. This is the
  stronger isolation and costs nothing extra on 1Claw.
- **A second 1Claw runtime** (paid add-on on Pro): the same template, source and startup command;
  `expose_http: false`; `env_public` `SCHEDULER_ENABLED=true`, `RUNTIME_VAULT_ID`,
  `AGENTS_VAULT_ID`, and the curator variables. Its bound agent must be able to read `agents/**`
  in `varada-curator-api-keys`. The Pro plan's ten agent slots are all curators, and a child agent
  cannot do it (a child's vaults and scopes must be a subset of its parent's), so this binds the
  runtime to one curator agent whose token is widened to the key vault. That container then holds
  every key, which is the trade-off the routines avoid.

Check `GET /health` on the chat runtime (`chat: true`), then a chat.

Local run: `cd agents/runtime && npm ci && INDEXER_URL=... ANTHROPIC_API_KEY=... npm start`.
Tests: `npm test`.
