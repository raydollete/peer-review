import { jest } from '@jest/globals';
import { CredentialProvider } from '../credential-provider.js';
import { ConfigurationError } from '../../../shared/errors/index.js';

describe('CredentialProvider', () => {
  describe('apiKeyEnv path', () => {
    it('returns the env var value', async () => {
      const provider = new CredentialProvider(
        { name: 's1', apiKeyEnv: 'S1_KEY' },
        { env: { S1_KEY: 'sk-secret' } },
      );
      const result = await provider.getCredential();
      expect(result._unsafeUnwrap()).toBe('sk-secret');
    });

    it('returns ConfigurationError for an unset env var', async () => {
      const provider = new CredentialProvider({ name: 's1', apiKeyEnv: 'S1_KEY' }, { env: {} });
      const result = await provider.getCredential();
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(ConfigurationError);
      expect(result._unsafeUnwrapErr().message).not.toContain('sk-');
    });
  });

  describe('apiKeyCommand path', () => {
    it('executes the command and trims stdout', async () => {
      const run = jest.fn().mockResolvedValue({ stdout: '  minted-token\n' });
      const provider = new CredentialProvider(
        { name: 's2', apiKeyCommand: 'mint-token' },
        { runCommand: run },
      );
      const result = await provider.getCredential();
      expect(result._unsafeUnwrap()).toBe('minted-token');
      expect(run).toHaveBeenCalledWith('mint-token');
    });

    it('caches within the TTL — command executed once', async () => {
      const run = jest.fn().mockResolvedValue({ stdout: 'tok\n' });
      let clock = 0;
      const provider = new CredentialProvider(
        { name: 's2', apiKeyCommand: 'mint' },
        { runCommand: run, ttlSeconds: 10, now: () => clock },
      );
      expect((await provider.getCredential())._unsafeUnwrap()).toBe('tok');
      clock = 5000;
      expect((await provider.getCredential())._unsafeUnwrap()).toBe('tok');
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('re-mints after TTL expiry', async () => {
      const run = jest
        .fn()
        .mockResolvedValueOnce({ stdout: 'tok1' })
        .mockResolvedValueOnce({ stdout: 'tok2' });
      let clock = 0;
      const provider = new CredentialProvider(
        { name: 's2', apiKeyCommand: 'mint' },
        { runCommand: run, ttlSeconds: 10, now: () => clock },
      );
      expect((await provider.getCredential())._unsafeUnwrap()).toBe('tok1');
      clock = 11_000;
      expect((await provider.getCredential())._unsafeUnwrap()).toBe('tok2');
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('invalidate() forces a re-mint (401 retry contract)', async () => {
      const run = jest
        .fn()
        .mockResolvedValueOnce({ stdout: 'stale' })
        .mockResolvedValueOnce({ stdout: 'fresh' });
      const provider = new CredentialProvider(
        { name: 's2', apiKeyCommand: 'mint' },
        { runCommand: run, ttlSeconds: 3000, now: () => 0 },
      );
      expect((await provider.getCredential())._unsafeUnwrap()).toBe('stale');
      provider.invalidate();
      expect((await provider.getCredential())._unsafeUnwrap()).toBe('fresh');
      expect(run).toHaveBeenCalledTimes(2);
    });

    it('maps non-zero exit to ConfigurationError without leaking output', async () => {
      const run = jest.fn().mockRejectedValue(new Error('exit 1: secret-material'));
      const provider = new CredentialProvider(
        { name: 's2', apiKeyCommand: 'mint' },
        { runCommand: run },
      );
      const result = await provider.getCredential();
      const error = result._unsafeUnwrapErr();
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error.message).not.toContain('secret-material');
    });

    it('maps empty output to ConfigurationError', async () => {
      const run = jest.fn().mockResolvedValue({ stdout: '   \n' });
      const provider = new CredentialProvider(
        { name: 's2', apiKeyCommand: 'mint' },
        { runCommand: run },
      );
      const result = await provider.getCredential();
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(ConfigurationError);
    });
  });
});
