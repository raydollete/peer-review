import { parsePeerConfig, loadPeerConfig, sourceAvailable } from '../index.js';
import { ConfigurationError } from '../../shared/errors/index.js';

const validConfig = {
  thresholds: { tier1: 2, tier2: 4 },
  arbiter: 'alpha',
  sources: [
    {
      name: 'alpha',
      apiType: 'openai',
      baseUrl: 'https://api.example.com/v1',
      model: 'model-a',
      apiKeyEnv: 'ALPHA_KEY',
      weight: 2,
      tier: 1,
    },
    {
      name: 'beta',
      apiType: 'anthropic',
      baseUrl: 'https://api.other.com',
      model: 'model-b',
      apiKeyCommand: 'echo token',
      weight: 2,
      tier: 2,
    },
  ],
};

function clone(): typeof validConfig & { sources: Array<Record<string, unknown>> } {
  return JSON.parse(JSON.stringify(validConfig));
}

describe('peer config', () => {
  it('parses a valid config and normalizes tier keys', () => {
    const config = parsePeerConfig(validConfig);
    expect(config.thresholds[1]).toBe(2);
    expect(config.thresholds[2]).toBe(4);
    expect(config.arbiter).toBe('alpha');
    expect(config.sources).toHaveLength(2);
  });

  it('parses the optional per-source local flag, defaulting undefined', () => {
    const raw = clone();
    raw.sources[0]!['local'] = true;
    const config = parsePeerConfig(raw);
    expect(config.sources[0]?.local).toBe(true);
    expect(config.sources[1]?.local).toBeUndefined();
  });

  it('parses the optional per-source jsonMode flag, defaulting undefined', () => {
    const raw = clone();
    raw.sources[0]!['jsonMode'] = true;
    const config = parsePeerConfig(raw);
    expect(config.sources[0]?.jsonMode).toBe(true);
    expect(config.sources[1]?.jsonMode).toBeUndefined();
  });

  it('rejects jsonMode on an anthropic source, naming the source', () => {
    const raw = clone();
    raw.sources[1]!['jsonMode'] = true;
    expect(() => parsePeerConfig(raw)).toThrow(ConfigurationError);
    expect(() => parsePeerConfig(raw)).toThrow(/Source "beta" declares jsonMode/);
  });

  it('accepts an anthropic source that does not declare jsonMode', () => {
    expect(() => parsePeerConfig(validConfig)).not.toThrow();
    expect(parsePeerConfig(validConfig).sources[1]?.apiType).toBe('anthropic');
  });

  it('accepts jsonMode on an openai source', () => {
    const raw = clone();
    raw.sources[0]!['jsonMode'] = true;
    expect(() => parsePeerConfig(raw)).not.toThrow();
  });

  it('parses optional per-source timeoutMs and maxOutputTokens', () => {
    const raw = clone();
    raw.sources[0]!['timeoutMs'] = 180000;
    raw.sources[0]!['maxOutputTokens'] = 16384;
    const config = parsePeerConfig(raw);
    expect(config.sources[0]?.timeoutMs).toBe(180000);
    expect(config.sources[0]?.maxOutputTokens).toBe(16384);
    expect(config.sources[1]?.timeoutMs).toBeUndefined();
    expect(config.sources[1]?.maxOutputTokens).toBeUndefined();
  });

  it('rejects non-positive or non-integer per-source limits', () => {
    for (const [key, value] of [
      ['timeoutMs', 0],
      ['timeoutMs', -5],
      ['maxOutputTokens', 1.5],
    ] as const) {
      const raw = clone();
      raw.sources[0]![key] = value;
      expect(() => parsePeerConfig(raw)).toThrow(ConfigurationError);
    }
  });

  it('accepts bare numeric threshold keys', () => {
    const raw = clone();
    (raw as Record<string, unknown>)['thresholds'] = { '1': 2, '2': 4 };
    expect(parsePeerConfig(raw).thresholds[1]).toBe(2);
  });

  it('fails fast on an unreadable config file', () => {
    expect(() => loadPeerConfig('/nonexistent/peer-review.config.json')).toThrow(
      ConfigurationError,
    );
  });

  it('fails fast on an invalid schema (bad baseUrl)', () => {
    const raw = clone();
    raw.sources[0]!['baseUrl'] = 'not-a-url';
    expect(() => parsePeerConfig(raw)).toThrow(ConfigurationError);
  });

  it('strips a trailing slash from baseUrl so adapters cannot build a double slash', () => {
    const raw = clone();
    raw.sources[0]!['baseUrl'] = 'https://openrouter.ai/api/v1/';
    expect(parsePeerConfig(raw).sources[0]!.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('fails fast on an unknown arbiter name', () => {
    const raw = clone();
    (raw as Record<string, unknown>)['arbiter'] = 'nobody';
    expect(() => parsePeerConfig(raw)).toThrow(/Arbiter "nobody"/);
  });

  it('fails fast when a source tier lacks a threshold', () => {
    const raw = clone();
    raw.sources[1]!['tier'] = 3;
    expect(() => parsePeerConfig(raw)).toThrow(/tier 3/);
  });

  it('fails fast when a source declares both apiKeyEnv and apiKeyCommand', () => {
    const raw = clone();
    raw.sources[0]!['apiKeyCommand'] = 'echo x';
    expect(() => parsePeerConfig(raw)).toThrow(/exactly one/);
  });

  it('fails fast when a source declares neither apiKeyEnv nor apiKeyCommand', () => {
    const raw = clone();
    delete raw.sources[0]!['apiKeyEnv'];
    expect(() => parsePeerConfig(raw)).toThrow(/exactly one/);
  });

  it('fails fast on duplicate source names', () => {
    const raw = clone();
    raw.sources[1]!['name'] = 'alpha';
    expect(() => parsePeerConfig(raw)).toThrow(/Duplicate source name/);
  });

  it('fails fast on the reserved source name "caller"', () => {
    const raw = clone();
    raw.sources[1]!['name'] = 'caller';
    expect(() => parsePeerConfig(raw)).toThrow(/"caller" is reserved/);
    expect(() => parsePeerConfig(validConfig)).not.toThrow();
  });

  it('marks a source with a missing apiKeyEnv var unavailable without throwing', () => {
    const config = parsePeerConfig(validConfig);
    const envSource = config.sources[0]!;
    expect(sourceAvailable(envSource, {})).toBe(false);
    expect(sourceAvailable(envSource, { ALPHA_KEY: 'sk-test' })).toBe(true);
  });

  it('treats apiKeyCommand sources as available without executing anything', () => {
    const config = parsePeerConfig(validConfig);
    expect(sourceAvailable(config.sources[1]!, {})).toBe(true);
  });
});

describe('env config', () => {
  it('applies defaults', async () => {
    const { loadEnvConfig } = await import('../env.config.js');
    const env = loadEnvConfig({});
    expect(env.timeoutMs).toBe(120000);
    expect(env.deadlineMs).toBe(750000);
    expect(env.maxOutputTokens).toBe(8192);
    expect(env.credentialTtlS).toBe(3000);
    expect(env.logLevel).toBe('info');
    expect(env.configPath).toBe('./peer-review.config.json');
  });

  it('coerces numeric overrides and rejects garbage', async () => {
    const { loadEnvConfig } = await import('../env.config.js');
    expect(loadEnvConfig({ PEER_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000);
    expect(() => loadEnvConfig({ PEER_TIMEOUT_MS: 'soon' })).toThrow(ConfigurationError);
  });

  it('parses PEER_REVIEW_SKIP_LOCAL as a boolean, defaulting false', async () => {
    const { loadEnvConfig } = await import('../env.config.js');
    expect(loadEnvConfig({}).skipLocal).toBe(false);
    expect(loadEnvConfig({ PEER_REVIEW_SKIP_LOCAL: 'true' }).skipLocal).toBe(true);
    expect(loadEnvConfig({ PEER_REVIEW_SKIP_LOCAL: '1' }).skipLocal).toBe(true);
    expect(loadEnvConfig({ PEER_REVIEW_SKIP_LOCAL: 'false' }).skipLocal).toBe(false);
    expect(loadEnvConfig({ PEER_REVIEW_SKIP_LOCAL: '0' }).skipLocal).toBe(false);
    expect(() => loadEnvConfig({ PEER_REVIEW_SKIP_LOCAL: 'yes' })).toThrow(ConfigurationError);
  });
});

describe('timeout-vs-deadline startup guard', () => {
  async function validate(rawConfig: unknown, env: Record<string, string>): Promise<void> {
    const { parsePeerConfig, loadEnvConfig } = await import('../index.js');
    const { validateTimeoutsAgainstDeadline } = await import('../validate-timeouts.js');
    validateTimeoutsAgainstDeadline(parsePeerConfig(rawConfig), loadEnvConfig(env));
  }

  it('throws when sequential tier waves plus arbitration cannot fit the deadline', async () => {
    const config = clone();
    // tier 1: 120000 + 120000; tier 2: 400000 + 120000 = 760000.
    config.sources[1]!['timeoutMs'] = 400000;
    await expect(
      validate(config, { PEER_TIMEOUT_MS: '120000', PEER_REVIEW_DEADLINE_MS: '480000' }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('names the tier allocations, arbiter timeout, and deadline', async () => {
    const config = clone();
    config.sources[1]!['timeoutMs'] = 400000;
    await expect(
      validate(config, { PEER_TIMEOUT_MS: '120000', PEER_REVIEW_DEADLINE_MS: '480000' }),
    ).rejects.toThrow(/tier 1.*120000.*tier 2.*400000.*120000.*480000/s);
  });

  it('passes when every sequential wave plus arbiter fits within the deadline', async () => {
    const config = clone();
    config.sources[1]!['timeoutMs'] = 200000; // (120000 + 120000) + (200000 + 120000) < 750000
    await expect(
      validate(config, { PEER_TIMEOUT_MS: '120000', PEER_REVIEW_DEADLINE_MS: '750000' }),
    ).resolves.toBeUndefined();
  });

  it('rejects the Kimi-shaped 480000ms deadline as too short for full escalation', async () => {
    const config = clone();
    config.sources[0]!['timeoutMs'] = 120000; // arbiter
    config.sources[1]!['timeoutMs'] = 300000;
    config.sources.push({
      name: 'deepseek',
      apiType: 'openai',
      baseUrl: 'https://api.example.com/v1',
      model: 'model-c',
      apiKeyEnv: 'DEEPSEEK_KEY',
      weight: 1,
      tier: 1,
      timeoutMs: 180000,
    });
    await expect(
      validate(config, { PEER_TIMEOUT_MS: '120000', PEER_REVIEW_DEADLINE_MS: '480000' }),
    ).rejects.toThrow(/720000.*480000/s);
  });

  it('accepts the shipped default config under default env', async () => {
    const { loadPeerConfig, loadEnvConfig } = await import('../index.js');
    const { validateTimeoutsAgainstDeadline } = await import('../validate-timeouts.js');
    // tier 1: 180000 + 120000; tier 2: 300000 + 120000 = 720000 < 750000.
    expect(() =>
      validateTimeoutsAgainstDeadline(
        loadPeerConfig('./peer-review.config.json'),
        loadEnvConfig({}),
      ),
    ).not.toThrow();
  });
});
