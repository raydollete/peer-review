export interface HistoryTurn {
  readonly role: 'user' | 'model';
  readonly content: string;
}

/** One ordered piece of a prompt. `reusable` means a later request in the same
 * run is expected to repeat every part up to and including this one, so an
 * adapter may ask its provider to cache that prefix. */
export interface PromptPart {
  readonly text: string;
  readonly reusable?: boolean | undefined;
}

/** The prompt as one string: parts joined in order; a string passes through. */
export function promptText(prompt: string | readonly PromptPart[]): string {
  return typeof prompt === 'string' ? prompt : prompt.map((part) => part.text).join('');
}

export interface PeerRequest {
  readonly prompt: string | readonly PromptPart[];
  readonly history?: readonly HistoryTurn[] | undefined;
  readonly systemInstruction?: string | undefined;
  /** Server-controlled sampling temperature; never client-suppliable. */
  readonly temperature?: number | undefined;
  /** Cooperative cancellation for deadlines and early-abort on quorum. */
  readonly signal?: AbortSignal | undefined;
  /** A request for a JSON-object reply where the adapter's wire format supports it; set by the arbiter path, never by peer calls. */
  readonly responseFormat?: 'json' | undefined;
}
