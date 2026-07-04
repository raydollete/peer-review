import type { ListPeersUseCase, PeerListing } from '../../domain/use-cases/index.js';
import { successResponse, type McpToolResponse } from '../../shared/types/index.js';

export class ListPeersController {
  constructor(private readonly useCase: ListPeersUseCase) {}

  async handle(_rawInput: unknown): Promise<McpToolResponse<PeerListing>> {
    return successResponse(this.useCase.execute());
  }
}
