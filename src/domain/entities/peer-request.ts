export interface HistoryTurn {
  readonly role: 'user' | 'model';
  readonly content: string;
}

export interface PeerRequest {
  readonly prompt: string;
  readonly history?: readonly HistoryTurn[] | undefined;
  readonly systemInstruction?: string | undefined;
  /** Server-controlled sampling temperature; never client-suppliable. */
  readonly temperature?: number | undefined;
  /** Cooperative cancellation for deadlines and early-abort on quorum. */
  readonly signal?: AbortSignal | undefined;
  /** A request for a JSON-object reply where the adapter's wire format supports it; set by the arbiter path, never by peer calls. */
  readonly responseFormat?: 'json' | undefined;
}
