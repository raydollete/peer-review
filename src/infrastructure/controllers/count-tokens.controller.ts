import type { CountTokensUseCase } from '../../domain/use-cases/index.js';
import { CountTokensInputSchema } from '../schemas/index.js';
import {
  successResponse,
  errorResponse,
  type McpToolResponse,
} from '../../shared/types/index.js';
import { failureFields } from './failure-fields.js';
import type { CallerCeiling } from '../../domain/use-cases/index.js';

export interface CountTokensResponseData {
  readonly totalTokens: number;
  readonly model: string;
  readonly source: string;
  readonly method: 'api' | 'estimate';
}

export class CountTokensController {
  constructor(
    private readonly useCase: CountTokensUseCase,
    /** Present only when the declared caller ceiling no longer clears the deadline. */
    private readonly callerCeiling?: CallerCeiling,
  ) {}

  async handle(rawInput: unknown): Promise<McpToolResponse<CountTokensResponseData>> {
    const parsed = CountTokensInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
      return errorResponse(
        'VALIDATION_ERROR',
        parsed.error.issues.map((issue) => issue.message).join(', '),
        { cause: 'validation', fix: `Correct the ${fields} argument${fields.includes(',') ? 's' : ''} and retry` },
      );
    }

    const result = await this.useCase.execute(parsed.data);
    if (result.isErr()) {
      return errorResponse(result.error.code, result.error.message, failureFields(result.error, this.callerCeiling));
    }
    return successResponse(result.value);
  }
}
