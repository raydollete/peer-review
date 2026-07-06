#!/usr/bin/env node
import { loadEnvConfig, loadPeerConfig, sourceAvailable } from './config/index.js';
import type { PeerSource } from './domain/ports/index.js';
import {
  PeerReviewQuorumUseCase,
  QueryPeerUseCase,
  ListPeersUseCase,
  CountTokensUseCase,
} from './domain/use-cases/index.js';
import { CredentialProvider, createAdapter } from './infrastructure/adapters/index.js';
import {
  PeerReviewController,
  QueryPeerController,
  ListPeersController,
  CountTokensController,
} from './infrastructure/controllers/index.js';
import {
  McpServer,
  ToolRegistry,
  peerReviewTool,
  queryPeerTool,
  listPeersTool,
  countTokensTool,
} from './infrastructure/mcp/index.js';
import { createLogger, type ILogger } from './shared/logger/index.js';
import { ConfigurationError } from './shared/errors/index.js';

function buildSources(logger: ILogger): { sources: PeerSource[]; arbiterName: string; deadlineMs: number; thresholds: Readonly<Record<number, number>> } {
  const env = loadEnvConfig();
  const config = loadPeerConfig(env.configPath);
  const limits = { timeoutMs: env.timeoutMs, maxOutputTokens: env.maxOutputTokens };

  const sources: PeerSource[] = config.sources.map((source) => {
    const credentialProvider = new CredentialProvider(source, {
      ttlSeconds: env.credentialTtlS,
    });
    const available = sourceAvailable(source);
    if (!available) {
      logger.warn('Source credential unavailable at startup; source marked unavailable', {
        source: source.name,
      });
    }
    return {
      name: source.name,
      model: source.model,
      apiType: source.apiType,
      weight: source.weight,
      tier: source.tier,
      available,
      client: createAdapter(source, limits, credentialProvider, {}, logger),
    };
  });

  return {
    sources,
    arbiterName: config.arbiter,
    deadlineMs: env.deadlineMs,
    thresholds: config.thresholds,
  };
}

async function main(): Promise<void> {
  const logLevel = process.env['LOG_LEVEL'] ?? 'info';
  const logger = createLogger(logLevel);

  const { sources, arbiterName, deadlineMs, thresholds } = buildSources(logger);
  const arbiter = sources.find((source) => source.name === arbiterName);
  if (arbiter === undefined) {
    throw new ConfigurationError(`Arbiter "${arbiterName}" not found among built sources`);
  }

  const peerReviewController = new PeerReviewController(
    new PeerReviewQuorumUseCase({ sources, arbiter, thresholds, deadlineMs, logger }),
  );
  const queryPeerController = new QueryPeerController(new QueryPeerUseCase(sources));
  const listPeersController = new ListPeersController(new ListPeersUseCase(sources));
  const countTokensController = new CountTokensController(new CountTokensUseCase(sources));

  const registry = new ToolRegistry();
  registry.register(peerReviewTool.name, {
    tool: peerReviewTool,
    handler: (args) => peerReviewController.handle(args),
  });
  registry.register(queryPeerTool.name, {
    tool: queryPeerTool,
    handler: (args) => queryPeerController.handle(args),
  });
  registry.register(listPeersTool.name, {
    tool: listPeersTool,
    handler: (args) => listPeersController.handle(args),
  });
  registry.register(countTokensTool.name, {
    tool: countTokensTool,
    handler: (args) => countTokensController.handle(args),
  });

  const server = new McpServer(registry, logger);
  await server.start();
  logger.info('peer-review-mcp ready', {
    sources: sources.map((s) => `${s.name}(t${s.tier},w${s.weight},${s.available ? 'up' : 'down'})`),
    arbiter: arbiterName,
  });
}

main().catch((error: unknown) => {
  // Startup failure: log to stderr and exit non-zero. Never touch stdout.
  process.stderr.write(`Fatal: ${String(error)}\n`);
  process.exit(1);
});
