# Peer Review MCP Server

A provider-agnostic MCP (Model Context Protocol) server that asks a **weighted quorum of external LLM peers** the same question and returns a consensus answer with a machine-consumable **certainty score**. It supports any OpenAI-compatible or Anthropic-compatible API, stacks sources in cost tiers, and degrades visibly (never silently) when a source is unavailable.


![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)
![Node: >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

## Features

- **Weighted quorum with a certainty score** — peers vote with configurable weights; every `peer_review` response carries a machine-consumable `certaintyScore`.
- **Provider-agnostic** — two wire formats (OpenAI `chat/completions`, Anthropic `v1/messages`) cover OpenAI, Gemini, OpenRouter, Ollama, vLLM, Anthropic, and most gateways.
- **Cost tiers with escalation** — tier 1 sources are consulted first; higher tiers only fan out on quorum shortfall.
- **Visible degradation** — failed or unavailable sources are itemized in the result, never silently dropped; an unmet quorum is a reported outcome, not an error.
- **No vendor SDKs** — all providers are reached over plain HTTPS `fetch`.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Tools](#tools)
- [Migrating from gemini-for-claude-mcp](#migrating-from-gemini-for-claude-mcp)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- Node >= 20

## Installation

```bash
git clone https://github.com/raydollete/peer-review.git && cd peer-review
npm install
npm run build        # emits dist/app.js
```

## Quick Start

Create a config file (default path `./peer-review.config.json`):

```jsonc
{
  "thresholds": { "tier1": 2, "tier2": 4 },          // weight targets — see "How tiers, weights, and thresholds interact"
  "arbiter": "gpt-large",                             // source name used for consensus evaluation
  "sources": [
    { "name": "gpt-large", "apiType": "openai",    "baseUrl": "https://api.openai.com/v1",  "model": "gpt-5.2", "apiKeyEnv": "OPENAI_API_KEY",  "weight": 2, "tier": 1 },
    { "name": "claude",    "apiType": "anthropic", "baseUrl": "https://api.anthropic.com",  "model": "claude-fable-5", "apiKeyEnv": "ANTHROPIC_API_KEY", "weight": 2, "tier": 2 }
  ]
}
```

Then register the server in Claude Code:

```bash
claude mcp add peer-review \
  --env PEER_REVIEW_CONFIG=/absolute/path/to/peer-review.config.json \
  --env OPENAI_API_KEY=sk-... \
  -- node /absolute/path/to/peer-review/dist/app.js
```

## Configuration

The server reads a JSON config file from `PEER_REVIEW_CONFIG` (default `./peer-review.config.json`). See `peer-review.config.example.json`.

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

### How tiers, weights, and thresholds interact

A `peer_review` call is a weighted vote. The config decides who votes, in what order, and how many votes win:

- **`weight`** — how much a source's agreement counts. Give larger weights to sources you trust more.
- **`tier`** — cost band. Tier 1 is consulted on every call; tier 2 only when tier 1 falls short; and so on. Put cheap, fast models in tier 1 and expensive frontier models above.
- **`thresholds`** — the agreeing weight required to declare quorum, keyed by *target* tier.

The one rule that is easy to miss:

> **A call has a single required weight: the threshold of its *target* tier.** The target tier is the highest configured tier unless the caller caps escalation with the `tier` input. Lower tiers' thresholds are not applied along the way — `thresholds.tier1` only ever binds a call made with `"tier": 1`.

So with the Quick Start config (`{"tier1": 2, "tier2": 4}`), a default call must accumulate agreeing weight **4** (tier 2's threshold). Escalation is lazy, not mandatory: if tier 1's agreeing weight alone reaches 4, tier 2 is never contacted.

Execution order for one call:

1. All sources of the lowest tier are queried **in parallel**.
2. As soon as the responses in hand could arithmetically meet the required weight, the arbiter (at temperature 0) rates each response 0–1 against its own consensus answer. A source **agrees** when its rating is ≥ 0.7; only agreeing sources' weights count.
3. If agreeing weight ≥ required weight, quorum is achieved: any still-in-flight requests are aborted (cost saved) and the arbiter's consensus answer is returned.
4. Otherwise the next tier fans out and the arbiter re-rates over **all** accumulated responses — earlier answers are never discarded.
5. Tiers that were never reached do not appear in `quorum.sources[]` at all.

Sizing guidance:

- **Overprovision each tier.** A tier whose potential weight exactly equals the threshold escalates the moment any one source fails or dissents. Three weight-1 sources against a threshold of 2 tolerate one outlier; two sources tolerate none.
- **Prefer model diversity within a tier.** Two copies of the same model mostly vote together, so their combined weight overstates the independence of the "second opinion".
- **Keep the required weight reachable.** The target tier's threshold must be ≤ the summed weight of all sources in tiers ≤ target, or `quorum.achieved` can never be true.
- **Pick a cheap, reliable arbiter.** The arbiter is called at least once per `peer_review` call plus once per escalation, and its tokens count toward `tokenUsage`. It can double as a regular peer. If the arbiter's own call fails, the whole evaluation falls back to `arbiterFailed: true` with `certaintyScore: 0` — so give the arbiter role to the source with your most dependable credential.

### Example: a three-tier stack

The walkthroughs below all use this config — two cheap flash-class voters in tier 1, a mid-price model in tier 2, a frontier model in tier 3:

```jsonc
{
  "thresholds": { "tier1": 2, "tier2": 3, "tier3": 4 },
  "arbiter": "gpt-mini",
  "sources": [
    { "name": "gemini-flash", "apiType": "openai",    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-3-flash-preview", "apiKeyEnv": "GEMINI_API_KEY",    "weight": 1, "tier": 1 },
    { "name": "gpt-mini",     "apiType": "openai",    "baseUrl": "https://api.openai.com/v1",                               "model": "gpt-5-mini",             "apiKeyEnv": "OPENAI_API_KEY",    "weight": 1, "tier": 1 },
    { "name": "gemini-pro",   "apiType": "openai",    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-3-pro",           "apiKeyEnv": "GEMINI_API_KEY",    "weight": 2, "tier": 2 },
    { "name": "claude",       "apiType": "anthropic", "baseUrl": "https://api.anthropic.com",                               "model": "claude-fable-5",         "apiKeyEnv": "ANTHROPIC_API_KEY", "weight": 2, "tier": 3 }
  ]
}
```

A default call targets tier 3, so it needs agreeing weight **4**. A `"tier": 1` call needs only **2**. Note the arbiter is `gpt-mini`, deliberately *not* one of the Gemini sources: if `GEMINI_API_KEY` ever goes missing, evaluation still works (see scenario 4).

### What happens when a query comes in

#### 1. Easy factual query — quorum at tier 2, tier 3 never billed

`{ "prompt": "What does HTTP status 431 mean? One sentence." }`

Tier 1 fans out to `gemini-flash` and `gpt-mini`; both agree, but their combined weight (2) can't reach the required 4, so tier 2 is consulted. `gemini-pro` agrees too: 1 + 1 + 2 = 4 ≥ 4 — quorum. `claude` is never called and never appears in `sources[]`.

```jsonc
// data
{
  "response": "HTTP 431 (Request Header Fields Too Large) means the server refused the request because its headers are too big.",
  "certaintyScore": 0.98,       // min(1, 4/4) × mean(1.0, 1.0, 0.95), rounded
  "quorum": {
    "achieved": true,
    "tier": 2,                  // tier reached; requiredWeight stays the target tier's threshold
    "requiredWeight": 4,
    "agreeingWeight": 4,
    "sources": [
      { "name": "gemini-flash", "model": "gemini-3-flash-preview", "status": "ok", "weight": 1, "agreement": 1 },
      { "name": "gpt-mini",     "model": "gpt-5-mini",             "status": "ok", "weight": 1, "agreement": 1 },
      { "name": "gemini-pro",   "model": "gemini-3-pro",           "status": "ok", "weight": 2, "agreement": 0.95 }
    ]
  },
  "tokenUsage": { "prompt": 812, "completion": 118, "total": 930 }   // includes both arbiter rounds
}
```

#### 2. Low-stakes check — cap escalation with `"tier": 1`

`{ "prompt": "Is 'reciept' spelled correctly?", "tier": 1 }`

Now the required weight is tier 1's threshold (2). Both flash sources agree, quorum is achieved in one round, and tiers 2–3 are never contacted regardless of the outcome. This is the cheap path for queries where two small models agreeing is good enough.

```jsonc
// data
{
  "response": "No — the correct spelling is \"receipt\".",
  "certaintyScore": 0.95,       // min(1, 2/2) × mean(1.0, 0.9)
  "quorum": {
    "achieved": true,
    "tier": 1,
    "requiredWeight": 2,
    "agreeingWeight": 2,
    "sources": [
      { "name": "gemini-flash", "model": "gemini-3-flash-preview", "status": "ok", "weight": 1, "agreement": 1 },
      { "name": "gpt-mini",     "model": "gpt-5-mini",             "status": "ok", "weight": 1, "agreement": 0.9 }
    ]
  },
  "tokenUsage": { "prompt": 296, "completion": 41, "total": 337 }
}
```

#### 3. Contested question — an outlier forces the full stack

`{ "prompt": "In Node 20, is structuredClone faster than a JSON round-trip for small flat objects?" }`

`gemini-flash` answers the opposite of everyone else and the arbiter rates it 0.2 — below the 0.7 agreement bar, so its weight is excluded (but still itemized). Agreeing weight climbs 1 → 3 → 5 as tiers 2 and 3 are pulled in, with the arbiter re-rating the accumulated set each round; quorum lands at tier 3.

```jsonc
// data
{
  "response": "For small flat objects a JSON round-trip is usually still faster in Node 20; structuredClone wins once values contain types JSON can't represent.",
  "certaintyScore": 0.9,        // min(1, 5/4) × mean(0.95, 0.9, 0.85) — outlier's 0.2 not averaged in
  "quorum": {
    "achieved": true,
    "tier": 3,
    "requiredWeight": 4,
    "agreeingWeight": 5,        // gpt-mini 1 + gemini-pro 2 + claude 2; gemini-flash excluded
    "sources": [
      { "name": "gemini-flash", "model": "gemini-3-flash-preview", "status": "ok", "weight": 1, "agreement": 0.2 },
      { "name": "gpt-mini",     "model": "gpt-5-mini",             "status": "ok", "weight": 1, "agreement": 0.95 },
      { "name": "gemini-pro",   "model": "gemini-3-pro",           "status": "ok", "weight": 2, "agreement": 0.9 },
      { "name": "claude",       "model": "claude-fable-5",         "status": "ok", "weight": 2, "agreement": 0.85 }
    ]
  },
  "tokenUsage": { "prompt": 2140, "completion": 486, "total": 2626 }
}
```

#### 4. Degraded run — missing credential, quorum unreachable

Same easy prompt as scenario 1, but `GEMINI_API_KEY` is unset, taking out both `gemini-flash` and `gemini-pro`. The remaining potential weight (`gpt-mini` 1 + `claude` 2 = 3) can never reach 4, so the call completes with `quorum.achieved: false` — still `success: true`, never an error. The degradation is itemized, not hidden.

```jsonc
// data
{
  "response": "HTTP 431 (Request Header Fields Too Large) means the server refused the request because its headers are too big.",
  "certaintyScore": 0.73,       // min(1, 3/4) × mean(1.0, 0.95), rounded — shortfall caps the score
  "quorum": {
    "achieved": false,
    "tier": 3,
    "requiredWeight": 4,
    "agreeingWeight": 3,
    "sources": [
      { "name": "gemini-flash", "model": "gemini-3-flash-preview", "status": "unavailable", "weight": 1, "agreement": null },
      { "name": "gpt-mini",     "model": "gpt-5-mini",             "status": "ok",          "weight": 1, "agreement": 1 },
      { "name": "gemini-pro",   "model": "gemini-3-pro",           "status": "unavailable", "weight": 2, "agreement": null },
      { "name": "claude",       "model": "claude-fable-5",         "status": "ok",          "weight": 2, "agreement": 0.95 }
    ]
  },
  "tokenUsage": { "prompt": 640, "completion": 97, "total": 737 }
}
```

Had the arbiter itself been the casualty (e.g. `OPENAI_API_KEY` missing in this config), no agreement could be evaluated at all and the response would instead carry the highest-weighted successful answer with `"certaintyScore": 0` and `"quorum": { "arbiterFailed": true, ... }`.

**Reading the result**: gate any automated decision on `quorum.achieved`, treat `certaintyScore` as the confidence dial (it discounts both shortfall and lukewarm agreement), and scan `sources[]` for `error`/`unavailable` entries — a degraded quorum is always visible, never silent.

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


This server fully supersedes [`gemini-for-claude-mcp`](#migrating-from-gemini-for-claude-mcp): Gemini becomes just one configured source, reachable via AI Studio or Vertex AI.

It is intended as a drop-in replacement: `query_peer` accepts the same `prompt`/`history` shape (`role: "user"|"model"` preserved) and returns the same payload fields as `query_gemini` plus `source`; `list_peers` covers `list_gemini_models`; `count_tokens` covers `count_gemini_tokens` (with the `method` caveat below). Configure Gemini as an ordinary source, either way:

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

Caveat: `count_tokens` for Gemini uses the `ceil(chars/4)` estimate (`"method": "estimate"`) rather than Gemini's native count endpoint.

## Development

```bash
npm run typecheck && npm run lint && npm test   # full suite
npm run dev                                     # tsx watch mode
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for layer rules, the quorum algorithm, and runtime guards.

## Contributing

Issues and pull requests are welcome. Before submitting a PR, run the full check suite:

```bash
npm run typecheck && npm run lint && npm test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
