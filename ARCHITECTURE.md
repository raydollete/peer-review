# Architecture

peer-review-mcp follows the flattened Clean Architecture of its reference project (`gemini-for-claude-mcp`): a provider-agnostic domain core, infrastructure adapters at the edges, manual dependency injection in the composition root, and `neverthrow` `Result` values instead of thrown exceptions on every fallible path.

## Layout and dependency flow

```
src/
  domain/            # pure core — no vendor names, no I/O, no SDKs
    entities/        # PeerRequest, PeerResponse, TokenCountResult, QuorumResult
    ports/           # IPeerClient (the single LLM port), PeerSource
    errors/          # PeerApiError, PeerRateLimitError (+ re-exported shared errors)
    use-cases/       # PeerReviewQuorumUseCase, agreement module, QueryPeer/ListPeers/CountTokens
  infrastructure/
    adapters/        # OpenAiCompatAdapter, AnthropicCompatAdapter, CredentialProvider, shared HTTP
    controllers/     # Zod-parse input → use-case → {success,data|error} envelope
    schemas/         # strict Zod input schemas for the MCP boundary
    mcp/             # stdio server, tool registry, tool definitions
  config/            # config-file (Zod) + env loading, fail-fast validation
  shared/            # DomainError base + common errors, pino logger (stderr), envelope helpers
  app.ts             # composition root: config → credential providers → adapters → use-cases → tools
```

Rules:

- **`domain/` never imports from `infrastructure/` or `config/`.** It sees outside LLMs only through `IPeerClient` and the `PeerSource` descriptor. `grep -riE 'openai|anthropic|gemini' src/domain/` returns zero hits — vendor identity lives in configuration, not code.
- **One port, two adapters.** `IPeerClient` (`complete`, `countTokens`) is implemented by the OpenAI-compatible adapter (`POST {baseUrl}/chat/completions`) and the Anthropic-compatible adapter (`POST {baseUrl}/v1/messages`). A factory binds a configured source's `apiType`, `baseUrl`, and `model` to an adapter instance. These two wire formats cover OpenAI, Gemini (AI Studio & Vertex OpenAI-compat endpoints), OpenRouter, Ollama, vLLM, Anthropic, and most gateways.
- **No vendor SDKs.** All outbound HTTP uses the Node 20+ global `fetch`.
- **Results, not exceptions.** Ports, use-cases, and controllers pass `Result<T, DomainError>`; only the MCP layer converts to the wire envelope. Handler throws are caught and returned as a generic `INTERNAL_ERROR`.
- **Validation at the boundary.** Strict Zod schemas parse tool input; `model`, `temperature`, and output limits are injected server-side from config and cannot be supplied by the client.
- **Credentials are indirection-only.** Each source authenticates via exactly one of `apiKeyEnv` (static key by env-var name) or `apiKeyCommand` (a command minting a short-lived bearer token, cached with a TTL). Credential values never appear in config, logs, errors, or responses. Resolution failure marks the source `unavailable`; it never crashes the server.

## The quorum algorithm

`peer_review` is orchestrated by `PeerReviewQuorumUseCase`:

1. **Target selection.** The caller may pass `tier` (highest tier to escalate to); default is the highest configured tier. `requiredWeight = thresholds[targetTier]`.
2. **Tiered parallel fan-out.** All tier-1 sources are called in parallel. Unavailable sources are itemized immediately (`status: "unavailable"`) and contribute nothing.
3. **Agreement evaluation.** The configured **arbiter** source receives the question and all successful responses as delimited data (never as instructions), at temperature 0, and must return strict JSON: a consensus answer plus a per-response agreement rating in [0, 1] (one re-ask on malformed JSON). A source *agrees* when its rating ≥ 0.7; only agreeing sources' weights count. When the caller supplied a `callerAnswer`, it enters here — and only here — as one extra fenced document (`<<<CALLER DOCUMENT source="caller">>>`, placed after all peer documents) that the arbiter rates against the consensus but is instructed never to use when forming it. The rating is split out of the peer ratings post-parse (surfaced as `callerAgreement`, zero quorum weight; a `caller` entry returned without a supplied answer is dropped), so peers stay blind and the quorum math never sees a phantom peer.
4. **Escalation.** If `agreeingWeight < requiredWeight`, the next tier fans out and agreement is re-evaluated over the **accumulated** response set. Repeat until quorum or tiers (≤ targetTier) are exhausted.
5. **Certainty.** `certaintyScore = min(1, agreeingWeight / requiredWeight) × meanAgreementOfAgreeingSources`. Failed/unavailable sources contribute 0 and are itemized — a degraded quorum is visible, never silent. An unmet quorum still returns `success: true` with `quorum.achieved: false`; the caller decides.

## Runtime guards

- **Global deadline** (`PEER_REVIEW_DEADLINE_MS`, default 240 s): on expiry, in-flight calls are aborted via `AbortController` and the accumulated partial result is returned — the MCP caller always gets a response, never a hang.
- **Early-abort on quorum:** once agreeing weight meets the threshold mid-tier, pending same-tier requests are aborted to save cost. Same-tick sibling responses are drained first so no completed answer is discarded.
- **Arbiter fallback:** if the arbiter fails (transport error, or malformed JSON after one re-ask), the response falls back to the highest-weighted successful source's answer with `certaintyScore: 0` and `quorum.arbiterFailed: true` — never a crashed request.
- **Arbiter hardening:** temperature 0, a rigid rubric system prompt, and peer responses wrapped in data delimiters (`<<<DOCUMENT n source="...">>>`) with explicit ignore-embedded-instructions rules, blunting cross-peer prompt injection. Per-source ratings are returned so an outlier hijack is inspectable.
- **Status-code error mapping:** adapters map errors from HTTP status only (429 → `PEER_RATE_LIMIT`, 404 → `PEER_API_ERROR` not-found, 401/403 → `CONFIGURATION_ERROR`, 5xx → `PEER_API_ERROR`), never from message text.
- **Retry with backoff:** 429/503/529 are retried with jittered exponential backoff (max 2 retries) inside the per-source timeout budget; a 401 invalidates the cached credential and retries exactly once with a re-minted token.
- **stdout hygiene:** the stdio transport owns stdout exclusively; pino logs to stderr (`destination: 2`). `console.log`/`process.stdout` do not appear in `src/`.

## Testing strategy

- **Domain tests** mock only the `IPeerClient` port (quorum escalation, early-abort, deadline partials, agreement semantics, certainty formula, arbiter fallback).
- **Adapter contract tests** pin request shapes and response parsing against recorded wire fixtures (success, 429, 5xx, malformed bodies) with an injected `fetch`, so wire-format drift fails loudly.
- **Controller tests** cover boundary validation (empty prompt, strict-schema rejection of `model`/`temperature`).
- **MCP tests** cover the envelope semantics (`TOOL_NOT_FOUND`, generic `INTERNAL_ERROR`, single text content block).
