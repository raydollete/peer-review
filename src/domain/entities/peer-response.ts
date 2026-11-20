export interface TokenUsage {
  /** The full prompt size, cached tokens included. */
  readonly promptTokens: number;
  /** Prompt tokens the provider served from cache — a subset of promptTokens. */
  readonly cachedPromptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface PeerResponse {
  readonly text: string;
  readonly model: string;
  readonly source: string;
  readonly finishReason: string;
  readonly usage: TokenUsage;
}
