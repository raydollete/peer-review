export interface McpToolResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export function successResponse<T>(data: T): McpToolResponse<T> {
  return { success: true, data };
}

export function errorResponse(code: string, message: string): McpToolResponse<never> {
  return { success: false, error: { code, message } };
}
