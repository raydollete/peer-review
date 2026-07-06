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
    expect(env.deadlineMs).toBe(480000);
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
});
