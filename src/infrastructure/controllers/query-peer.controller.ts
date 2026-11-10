import type { QueryPeerUseCase } from '../../domain/use-cases/index.js';
import { QueryPeerInputSchema } from '../schemas/index.js';
import {
  successResponse,
  errorResponse,
  type McpToolResponse,
} from '../../shared/types/index.js';
import { failureFields } from './failure-fields.js';
import type { CallerCeiling } from '../../domain/use-cases/index.js';

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
  constructor(
    private readonly useCase: QueryPeerUseCase,
    /** Present only when the declared caller ceiling no longer clears the deadline. */
    private readonly callerCeiling?: CallerCeiling,
  ) {}

  async handle(
    rawInput: unknown,
    callerSignal?: AbortSignal,
  ): Promise<McpToolResponse<QueryPeerResponseData>> {
    const parsed = QueryPeerInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
      return errorResponse(
        'VALIDATION_ERROR',
        parsed.error.issues.map((issue) => issue.message).join(', '),
        { cause: 'validation', fix: `Correct the ${fields} argument${fields.includes(',') ? 's' : ''} and retry` },
      );
    }

    const result = await this.useCase.execute(parsed.data, callerSignal);
    if (result.isErr()) {
      return errorResponse(result.error.code, result.error.message, failureFields(result.error, this.callerCeiling));
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
