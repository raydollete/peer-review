#!/usr/bin/env node
import {
  loadEnvConfig,
  loadPeerConfig,
  sourceAvailable,
  validateTimeoutsAgainstDeadline,
} from './config/index.js';
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

function collectTierTimeouts(
  sources: ReturnType<typeof loadPeerConfig>['sources'],
  defaultTimeoutMs: number,
): Record<number, number> {
  return sources.reduce<Record<number, number>>((timeouts, source) => {
    timeouts[source.tier] = Math.max(timeouts[source.tier] ?? 0, source.timeoutMs ?? defaultTimeoutMs);
    return timeouts;
  }, {});
}

function buildSources(logger: ILogger): {
  sources: PeerSource[];
  arbiterName: string;
  deadlineMs: number;
  arbiterTimeoutMs: number;
  tierTimeoutMs: Readonly<Record<number, number>>;
  skipLocal: boolean;
  thresholds: Readonly<Record<number, number>>;
} {
  const env = loadEnvConfig();
  const config = loadPeerConfig(env.configPath);
  // Fail fast if the full sequential escalation path cannot fit the deadline.
  validateTimeoutsAgainstDeadline(config, env);
  const limits = { timeoutMs: env.timeoutMs, maxOutputTokens: env.maxOutputTokens };
  const arbiterConfig = config.sources.find((s) => s.name === config.arbiter);
  const arbiterTimeoutMs = arbiterConfig?.timeoutMs ?? env.timeoutMs;
  const tierTimeoutMs = collectTierTimeouts(config.sources, env.timeoutMs);

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
      local: source.local ?? false,
      client: createAdapter(source, limits, credentialProvider, {}, logger),
    };
  });

  if (env.skipLocal && !sources.some((s) => s.local === true)) {
    logger.warn('PEER_REVIEW_SKIP_LOCAL is set but no source is flagged local; nothing skipped');
  }

  return {
    sources,
    arbiterName: config.arbiter,
    deadlineMs: env.deadlineMs,
    arbiterTimeoutMs,
    tierTimeoutMs,
    skipLocal: env.skipLocal,
    thresholds: config.thresholds,
  };
}

async function main(): Promise<void> {
  const logLevel = process.env['LOG_LEVEL'] ?? 'info';
  const logger = createLogger(logLevel);

  const { sources, arbiterName, deadlineMs, arbiterTimeoutMs, tierTimeoutMs, skipLocal, thresholds } =
    buildSources(logger);
  const arbiter = sources.find((source) => source.name === arbiterName);
  if (arbiter === undefined) {
    throw new ConfigurationError(`Arbiter "${arbiterName}" not found among built sources`);
  }

  const peerReviewController = new PeerReviewController(
    new PeerReviewQuorumUseCase({
      sources,
      arbiter,
      thresholds,
      deadlineMs,
      arbiterTimeoutMs,
      tierTimeoutMs,
      skipLocal,
      logger,
    }),
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
