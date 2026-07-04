export interface TokenUsage {
  readonly promptTokens: number;
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
