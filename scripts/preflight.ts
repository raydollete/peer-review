/**
 * Preflight: exercise every configured source end-to-end and report what broke.
 *
 * Loads the same env + peer config the MCP server loads, mints each credential
 * through the real CredentialProvider, and sends one tiny prompt through the
 * real adapter. Failures are reported per source rather than aborting, so a
 * single dead provider does not hide the state of the others.
 *
 *   npm run preflight                  # every source, cheap probe
 *   npm run preflight -- kimi-k3       # only the named source(s)
 *   npm run preflight -- --deep        # reasoning-weight probe (real cost/latency)
 *
 * The cheap probe proves credential + endpoint + model id. It does NOT prove the
 * token budget is workable: a reasoning model answers "say OK" in a few dozen
 * tokens and burns thousands on a real review prompt. Use --deep for that.
 */
import { loadEnvConfig, loadPeerConfig, type SourceConfig } from '../src/config/index.js';
import {
  createAdapter,
  CredentialProvider,
} from '../src/infrastructure/adapters/index.js';

const CHEAP_PROMPT = 'Reply with exactly the word OK and nothing else.';

// Shaped like a real arbitration prompt: enough analytical load that a reasoning
// model spends a realistic hidden-thinking budget before it emits any answer.
const DEEP_PROMPT =
  'Critique this design and give five distinct concerns, each with a concrete ' +
  'failure scenario: a service fans out one prompt to several LLMs in parallel, ' +
  'sends every answer to one arbiter model for per-source agreement ratings, sums ' +
  'those ratings by integer weight, and escalates to a second, larger fan-out when ' +
  'the sum misses a threshold — all inside one shared 750s deadline. Be specific ' +
  'about deadline budgeting, arbiter self-rating, threshold calibration, and ' +
  'partial-outage semantics.';

interface Outcome {
  readonly source: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

async function checkSource(
  source: SourceConfig,
  env: ReturnType<typeof loadEnvConfig>,
  prompt: string,
): Promise<Outcome> {
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;

  const credentials = new CredentialProvider(source, { ttlSeconds: env.credentialTtlS });
  const credential = await credentials.getCredential();
  if (credential.isErr()) {
    return { source: source.name, ok: false, ms: elapsed(), detail: `credential: ${credential.error.message}` };
  }

  const timeoutMs = source.timeoutMs ?? env.timeoutMs;
  const maxOutputTokens = source.maxOutputTokens ?? env.maxOutputTokens;
  const adapter = createAdapter(source, { timeoutMs, maxOutputTokens }, credentials);

  const response = await adapter.complete({ prompt });
  if (response.isErr()) {
    return { source: source.name, ok: false, ms: elapsed(), detail: response.error.message };
  }

  const { text, finishReason, usage } = response.value;
  // A truncated answer is a live credential and a wrong token budget, not a
  // healthy source — reasoning models burn max_tokens before emitting content.
  const truncated = finishReason === 'length';
  return {
    source: source.name,
    ok: !truncated,
    ms: elapsed(),
    detail:
      `finish=${finishReason} tokens=${usage.completionTokens}/${maxOutputTokens} ` +
      `timeout=${timeoutMs}ms text=${JSON.stringify(text.slice(0, 60))}` +
      (truncated ? ' — TRUNCATED: raise maxOutputTokens for this source' : ''),
  };
}

async function main(): Promise<void> {
  const env = loadEnvConfig();
  const config = loadPeerConfig(env.configPath);

  const argv = process.argv.slice(2);
  const deep = argv.includes('--deep');
  const requested = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = requested.filter((name) => !config.sources.some((s) => s.name === name));
  if (unknown.length > 0) {
    console.error(`Unknown source(s): ${unknown.join(', ')}`);
    console.error(`Configured: ${config.sources.map((s) => s.name).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const sources =
    requested.length > 0 ? config.sources.filter((s) => requested.includes(s.name)) : config.sources;

  console.log(`config: ${env.configPath}`);
  console.log(`arbiter: ${config.arbiter}   thresholds: ${JSON.stringify(config.thresholds)}`);
  console.log(`defaults: timeout=${env.timeoutMs}ms maxOutputTokens=${env.maxOutputTokens}`);
  console.log(`probe: ${deep ? 'deep (reasoning-weight)' : 'cheap (--deep for a real load)'}\n`);

  const prompt = deep ? DEEP_PROMPT : CHEAP_PROMPT;
  const outcomes = await Promise.all(sources.map((source) => checkSource(source, env, prompt)));

  for (const outcome of outcomes) {
    const mark = outcome.ok ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${outcome.source.padEnd(16)} ${String(outcome.ms).padStart(6)}ms  ${outcome.detail}`);
  }

  const failed = outcomes.filter((outcome) => !outcome.ok);
  console.log(`\n${outcomes.length - failed.length}/${outcomes.length} sources healthy`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
