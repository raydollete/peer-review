import type { CountTokensUseCase } from '../../domain/use-cases/index.js';
import { CountTokensInputSchema } from '../schemas/index.js';
import {
  successResponse,
  errorResponse,
  type McpToolResponse,
} from '../../shared/types/index.js';

export interface CountTokensResponseData {
  readonly totalTokens: number;
  readonly model: string;
  readonly source: string;
  readonly method: 'api' | 'estimate';
}

export class CountTokensController {
  constructor(private readonly useCase: CountTokensUseCase) {}

  async handle(rawInput: unknown): Promise<McpToolResponse<CountTokensResponseData>> {
    const parsed = CountTokensInputSchema.safeParse(rawInput);
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
    return successResponse(result.value);
  }
}
