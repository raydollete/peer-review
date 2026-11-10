import type { PeerReviewFailureCause } from '../../domain/errors/index.js';

/** Optional machine-cause members the failure envelope may carry beside
 * `code`/`message`. All optional: a two-argument `errorResponse` serializes
 * byte-identically to the pre-change `{code, message}` object. */
export interface McpToolErrorFields {
  readonly cause?: PeerReviewFailureCause;
  readonly source?: string;
  readonly detail?: string;
  readonly fix?: string;
  /** The per-source roster (and correlationId on the redacted catch-all). */
  readonly context?: Record<string, unknown>;
}

export interface McpToolResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly cause?: PeerReviewFailureCause;
    readonly source?: string;
    readonly detail?: string;
    readonly fix?: string;
    readonly context?: Record<string, unknown>;
  };
}

export function successResponse<T>(data: T): McpToolResponse<T> {
  return { success: true, data };
}

export function errorResponse(
  code: string,
  message: string,
  fields?: McpToolErrorFields,
): McpToolResponse<never> {
  return {
    success: false,
    error: {
      code,
      message,
      // Conditional spreads: with no third argument the JSON has exactly
      // `code` and `message` (exactOptionalPropertyTypes).
      ...(fields?.cause !== undefined ? { cause: fields.cause } : {}),
      ...(fields?.source !== undefined ? { source: fields.source } : {}),
      ...(fields?.detail !== undefined ? { detail: fields.detail } : {}),
      ...(fields?.fix !== undefined ? { fix: fields.fix } : {}),
      ...(fields?.context !== undefined ? { context: fields.context } : {}),
    },
  };
}
