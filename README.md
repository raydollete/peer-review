# peer-review-mcp

A provider-agnostic MCP (Model Context Protocol) server that asks a **weighted quorum of external LLM peers** the same question and returns a consensus answer with a machine-consumable **certainty score**. It supports any OpenAI-compatible or Anthropic-compatible API, stacks sources in cost tiers, and degrades visibly (never silently) when a source is unavailable.

It fully supersedes [`gemini-for-claude-mcp`](#migrating-from-gemini-for-claude-mcp): Gemini becomes just one configured source, reachable via AI Studio or Vertex AI.

## Install

```bash
git clone <this repo> && cd peer-review
npm install
npm run build        # emits dist/app.js
```

Requires Node >= 20. No vendor SDKs are used — all providers are reached over plain HTTPS `fetch`.

## Configuration

The server reads a JSON config file from `PEER_REVIEW_CONFIG` (default `./peer-review.config.json`). See `peer-review.config.example.json`.

```jsonc
{
  "thresholds": { "tier1": 2, "tier2": 4 },          // per-tier cumulative weight targets
  "arbiter": "gpt-large",                             // source name used for consensus evaluation
  "sources": [
    { "name": "gpt-large", "apiType": "openai",    "baseUrl": "https://api.openai.com/v1",  "model": "gpt-5.2", "apiKeyEnv": "OPENAI_API_KEY",  "weight": 2, "tier": 1 },
    { "name": "claude",    "apiType": "anthropic", "baseUrl": "https://api.anthropic.com",  "model": "claude-fable-5", "apiKeyEnv": "ANTHROPIC_API_KEY", "weight": 2, "tier": 2 }
  ]
}
```

### Config file fields

| Field | Type | Required | Description |
|---|---|---|---|
| `thresholds` | object | yes | Map of tier → positive integer weight target. Keys may be `"tier1"` or `"1"`. Every tier used by a source must have a threshold (validated at startup). |
| `arbiter` | string | yes | Name of the source used to evaluate agreement between peer responses. Must match a `sources[].name`. |
| `sources[].name` | string | yes | Unique source name (used in `query_peer`/`count_tokens` and in quorum reports). |
| `sources[].apiType` | `"openai"` \| `"anthropic"` | yes | Wire format: `openai` → `POST {baseUrl}/chat/completions`; `anthropic` → `POST {baseUrl}/v1/messages`. |
| `sources[].baseUrl` | URL | yes | API base URL. For `openai`, include the version segment (e.g. `https://api.openai.com/v1`). |
| `sources[].model` | string | yes | Model id sent to the provider. Never client-suppliable. |
| `sources[].apiKeyEnv` | string | exactly one of these two | Name of the environment variable holding a static API key. If the variable is unset the source is marked unavailable (the server still starts). |
| `sources[].apiKeyCommand` | string | exactly one of these two | Command executed (via `sh -c`) to mint a short-lived bearer token, e.g. `gcloud auth print-access-token` for Vertex AI. Output is trimmed and cached (see `PEER_CREDENTIAL_TTL_S`); a 401 triggers one re-mint + retry. |
| `sources[].weight` | positive int | yes | Weight this source contributes to quorum when it agrees with the consensus. |
| `sources[].tier` | positive int | yes | Cost tier. Tier 1 is consulted first; higher tiers only on shortfall. |

Startup fails fast on: an unreadable/invalid config file, an unknown `arbiter` name, a source tier without a threshold, duplicate source names, or a source declaring both or neither of `apiKeyEnv`/`apiKeyCommand`. Credential material never appears in config, logs, or responses.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PEER_REVIEW_CONFIG` | `./peer-review.config.json` | Path to the config file. |
| `PEER_TIMEOUT_MS` | `120000` | Per-source request timeout (includes retries). |
| `PEER_REVIEW_DEADLINE_MS` | `240000` | Hard overall deadline for one `peer_review` call; on expiry in-flight calls are aborted and the accumulated (possibly degraded) result is returned. |
| `PEER_MAX_OUTPUT_TOKENS` | `8192` | Max output tokens injected server-side into every peer call. |
| `PEER_CREDENTIAL_TTL_S` | `3000` | Cache TTL (seconds) for tokens minted via `apiKeyCommand`. |
| `LOG_LEVEL` | `info` | pino log level (`fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace`). Logs go to stderr only. |
| `NODE_ENV` | — | `production` switches the logger from pretty-printing to JSON. |

## Registering in Claude Code

```bash
claude mcp add peer-review \
  --env PEER_REVIEW_CONFIG=/absolute/path/to/peer-review.config.json \
  --env OPENAI_API_KEY=sk-... \
  -- node /absolute/path/to/peer-review/dist/app.js
```

## Tools

All tools return the envelope `{"success": true, "data": ...}` or `{"success": false, "error": {"code", "message"}}`, JSON-stringified into a single text content block (compatible with the reference Gemini MCP). Error codes: `VALIDATION_ERROR`, `CONFIGURATION_ERROR`, `TIMEOUT_ERROR`, `EXTERNAL_SERVICE_ERROR`, `PEER_API_ERROR`, `PEER_RATE_LIMIT`, `TOOL_NOT_FOUND`, `INTERNAL_ERROR`. Model, temperature, and output limits are injected server-side — the input schemas are strict, so client-supplied `model`/`temperature` are rejected.

### `peer_review`

Weighted-quorum consultation. Input: `prompt` (1–100000 chars), optional `history` (`[{role: "user"|"model", content}]`), optional `tier` (highest tier to escalate to; defaults to the full stack). An unmet quorum is **not** an error — check `quorum.achieved` and `certaintyScore`.

```jsonc
// request
{ "prompt": "What is the capital of France? Answer with just the city name." }
// response data
{
  "response": "Paris",
  "certaintyScore": 1,                    // min(1, agreeingWeight/requiredWeight) × mean agreement of agreeing sources
  "quorum": {
    "achieved": true,
    "tier": 1,
    "requiredWeight": 2,
    "agreeingWeight": 2,
    "sources": [
      { "name": "gemini-a", "model": "google/gemini-3.5-flash", "status": "ok", "weight": 1, "agreement": 1 },
      { "name": "gemini-b", "model": "google/gemini-3.5-flash", "status": "ok", "weight": 1, "agreement": 1 }
    ]
  },
  "tokenUsage": { "prompt": 315, "completion": 45, "total": 360 }   // aggregated across peers + arbiter
}
```

`sources[].status` is `ok`, `error`, or `unavailable`; `agreement` is the arbiter's 0–1 rating (`null` if the source produced no rated response). If the arbiter itself fails, the response falls back to the highest-weighted successful answer with `certaintyScore: 0` and `quorum.arbiterFailed: true`.

### `query_peer`

Single-source escape hatch mirroring the reference `query_gemini`. Input: `prompt`, optional `history`, optional `source` (defaults to the lowest-tier highest-weight source).

```jsonc
// request
{ "prompt": "In one word, what color is the sky on a clear day?", "source": "gemini" }
// response data
{ "response": "Blue", "model": "google/gemini-3.5-flash", "source": "gemini", "finishReason": "stop",
  "tokenUsage": { "prompt": 14, "completion": 1, "total": 15 } }
```

### `list_peers`

No input. Returns every configured source with availability (`available` = credential resolvable):

```jsonc
{ "sources": [ { "name": "gpt-large", "apiType": "openai", "model": "gpt-5.2", "weight": 2, "tier": 1, "available": true } ], "count": 1 }
```

### `count_tokens`

Input: `text` (1–1000000 chars), optional `source`. Anthropic-compatible sources use the provider's count endpoint (`"method": "api"`); OpenAI-compatible sources use a `ceil(chars/4)` heuristic (`"method": "estimate"`).

```jsonc
{ "totalTokens": 42, "model": "claude-fable-5", "source": "claude", "method": "api" }
```

## Migrating from gemini-for-claude-mcp

This server is a drop-in replacement: `query_peer` accepts the same `prompt`/`history` shape (`role: "user"|"model"` preserved) and returns the same payload fields as `query_gemini` plus `source`; `list_peers` covers `list_gemini_models`; `count_tokens` covers `count_gemini_tokens` (with the `method` caveat below). Configure Gemini as an ordinary source, either way:

**AI Studio (static key):**

```json
{ "name": "gemini", "apiType": "openai",
  "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
  "model": "gemini-3-pro", "apiKeyEnv": "GEMINI_API_KEY", "weight": 2, "tier": 1 }
```

**Vertex AI (short-lived OAuth token via gcloud):**

```json
{ "name": "gemini", "apiType": "openai",
  "baseUrl": "https://aiplatform.googleapis.com/v1beta1/projects/YOUR_PROJECT/locations/global/endpoints/openapi",
  "model": "google/gemini-3.5-flash",
  "apiKeyCommand": "gcloud auth print-access-token", "weight": 2, "tier": 1 }
```

Caveats:
- `count_tokens` for Gemini uses the `ceil(chars/4)` estimate (`"method": "estimate"`) rather than Gemini's native count endpoint.
- Repointing radflow's `review:` block (in `~/dev/radflow/openspec-config.yaml`) from `mcp__gemini__query_gemini` to this server's tools is a **separate change in the radflow repo** — do it after registering this server.

## Development

```bash
npm run typecheck && npm run lint && npm test   # full suite
npm run dev                                     # tsx watch mode
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for layer rules, the quorum algorithm, and runtime guards.
