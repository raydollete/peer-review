import type { QueryPeerUseCase } from '../../domain/use-cases/index.js';
import { QueryPeerInputSchema } from '../schemas/index.js';
import {
  successResponse,
  errorResponse,
  type McpToolResponse,
} from '../../shared/types/index.js';

export interface QueryPeerResponseData {
  readonly response: string;
  readonly model: string;
  readonly source: string;
  readonly finishReason: string;
  readonly tokenUsage: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
}

export class QueryPeerController {
  constructor(private readonly useCase: QueryPeerUseCase) {}

  async handle(rawInput: unknown): Promise<McpToolResponse<QueryPeerResponseData>> {
    const parsed = QueryPeerInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return errorResponse(
        'VALIDATION_ERROR',
        parsed.error.issues.map((issue) => issue.message).join(', '),
      );
    }

    const result = await this.useCase.execute(parsed.data);
    if (result.isErr()) {
      return errorResponse(result.error.code, result.error.message);
    }

    const response = result.value;
    return successResponse({
      response: response.text,
      model: response.model,
      source: response.source,
      finishReason: response.finishReason,
      tokenUsage: {
        prompt: response.usage.promptTokens,
        completion: response.usage.completionTokens,
        total: response.usage.totalTokens,
      },
    });
  }
}
