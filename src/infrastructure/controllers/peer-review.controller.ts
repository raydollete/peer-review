import type { PeerReviewQuorumUseCase } from '../../domain/use-cases/index.js';
import type { QuorumSourceReport } from '../../domain/entities/index.js';
import { PeerReviewInputSchema } from '../schemas/index.js';
import {
  successResponse,
  errorResponse,
  type McpToolResponse,
} from '../../shared/types/index.js';

export interface PeerReviewResponseData {
  readonly response: string;
  readonly certaintyScore: number;
  readonly quorum: {
    readonly achieved: boolean;
    readonly tier: number;
    readonly requiredWeight: number;
    readonly agreeingWeight: number;
    readonly arbiterFailed?: boolean;
    readonly sources: readonly QuorumSourceReport[];
  };
  readonly tokenUsage: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
}

export class PeerReviewController {
  constructor(private readonly useCase: PeerReviewQuorumUseCase) {}

  async handle(rawInput: unknown): Promise<McpToolResponse<PeerReviewResponseData>> {
    const parsed = PeerReviewInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return errorResponse(
        'VALIDATION_ERROR',
        parsed.error.issues.map((issue) => issue.message).join(', '),
      );
    }

    // Model, temperature, and output limits are injected server-side; the tool
    // input schema is strict so a client cannot smuggle them in.
    const result = await this.useCase.execute(parsed.data);
    if (result.isErr()) {
      return errorResponse(result.error.code, result.error.message);
    }

    const quorum = result.value;
    return successResponse({
      response: quorum.response,
      certaintyScore: quorum.certaintyScore,
      quorum: {
        achieved: quorum.achieved,
        tier: quorum.tier,
        requiredWeight: quorum.requiredWeight,
        agreeingWeight: quorum.agreeingWeight,
        ...(quorum.arbiterFailed === true ? { arbiterFailed: true } : {}),
        sources: quorum.sources,
      },
      tokenUsage: {
        prompt: quorum.usage.promptTokens,
        completion: quorum.usage.completionTokens,
        total: quorum.usage.totalTokens,
      },
    });
  }
}
