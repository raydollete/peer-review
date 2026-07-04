import type { IPeerClient } from '../../domain/ports/index.js';
import type { SourceConfig } from '../../config/index.js';
import type { ICredentialProvider } from './credential-provider.js';
import { OpenAiCompatAdapter } from './openai-compat.adapter.js';
import { AnthropicCompatAdapter } from './anthropic-compat.adapter.js';
import type { HttpDeps } from './http.js';

export interface AdapterLimits {
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
}

export function createAdapter(
  source: SourceConfig,
  limits: AdapterLimits,
  credentialProvider: ICredentialProvider,
  deps: HttpDeps = {},
): IPeerClient {
  const cfg = {
    sourceName: source.name,
    baseUrl: source.baseUrl,
    model: source.model,
    timeoutMs: limits.timeoutMs,
    maxOutputTokens: limits.maxOutputTokens,
    credentialProvider,
  };
  switch (source.apiType) {
    case 'openai':
      return new OpenAiCompatAdapter(cfg, deps);
    case 'anthropic':
      return new AnthropicCompatAdapter(cfg, deps);
  }
}
