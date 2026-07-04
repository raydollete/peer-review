export interface TokenCountResult {
  readonly totalTokens: number;
  readonly model: string;
  readonly method: 'api' | 'estimate';
}
