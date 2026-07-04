import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ok, err, type Result } from 'neverthrow';
import { ConfigurationError, type DomainError } from '../../shared/errors/index.js';

const execFileAsync = promisify(execFile);

export type CommandRunner = (command: string) => Promise<{ stdout: string }>;

const defaultRunCommand: CommandRunner = async (command) =>
  execFileAsync('/bin/sh', ['-c', command]);

export interface ICredentialProvider {
  getCredential(): Promise<Result<string, DomainError>>;
  /** Drop any cached credential so the next call re-mints (e.g. after a 401). */
  invalidate(): void;
}

export interface CredentialSource {
  readonly name: string;
  readonly apiKeyEnv?: string | undefined;
  readonly apiKeyCommand?: string | undefined;
}

export interface CredentialProviderOptions {
  readonly ttlSeconds?: number;
  readonly runCommand?: CommandRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

const DEFAULT_TTL_SECONDS = 3000;

export class CredentialProvider implements ICredentialProvider {
  private cached: { value: string; expiresAt: number } | undefined;
  private readonly ttlMs: number;
  private readonly runCommand: CommandRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(
    private readonly source: CredentialSource,
    options: CredentialProviderOptions = {},
  ) {
    this.ttlMs = (options.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  async getCredential(): Promise<Result<string, DomainError>> {
    if (this.source.apiKeyEnv !== undefined) {
      return this.fromEnv(this.source.apiKeyEnv);
    }
    if (this.source.apiKeyCommand !== undefined) {
      return this.fromCommand(this.source.apiKeyCommand);
    }
    return err(new ConfigurationError(`Source "${this.source.name}" has no credential configured`));
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private fromEnv(varName: string): Result<string, DomainError> {
    const value = this.env[varName];
    if (value === undefined || value.length === 0) {
      return err(
        new ConfigurationError(
          `Environment variable "${varName}" for source "${this.source.name}" is not set`,
        ),
      );
    }
    return ok(value);
  }

  private async fromCommand(command: string): Promise<Result<string, DomainError>> {
    if (this.cached !== undefined && this.now() < this.cached.expiresAt) {
      return ok(this.cached.value);
    }

    let stdout: string;
    try {
      ({ stdout } = await this.runCommand(command));
    } catch {
      // Never propagate command output/error detail: it can carry credential material.
      return err(
        new ConfigurationError(
          `Credential command for source "${this.source.name}" failed (non-zero exit)`,
        ),
      );
    }

    const value = stdout.trim();
    if (value.length === 0) {
      return err(
        new ConfigurationError(
          `Credential command for source "${this.source.name}" produced empty output`,
        ),
      );
    }

    this.cached = { value, expiresAt: this.now() + this.ttlMs };
    return ok(value);
  }
}
