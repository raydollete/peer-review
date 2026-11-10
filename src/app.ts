#!/usr/bin/env node
import {
  loadEnvConfig,
  loadPeerConfig,
  sourceAvailable,
  validateTimeoutsAgainstDeadline,
  callerCeilingMismatch,
  type EnvConfig,
  type SourceConfig,
} from './config/index.js';
import type { PeerSource } from './domain/ports/index.js';
import {
  PeerReviewQuorumUseCase,
  QueryPeerUseCase,
  ListPeersUseCase,
  CountTokensUseCase,
  type CallerCeiling,
} from './domain/use-cases/index.js';
import {
  CredentialProvider,
  createAdapter,
  type AdapterLimits,
} from './infrastructure/adapters/index.js';
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

interface BuiltSources {
  sources: PeerSource[];
  arbiterName: string;
  deadlineMs: number;
  arbiterTimeoutMs: number;
  tierTimeoutMs: Readonly<Record<number, number>>;
  skipLocal: boolean;
  thresholds: Readonly<Record<number, number>>;
  callerTimeoutMs: number;
  callerCeiling: CallerCeiling | undefined;
}

interface Controllers {
  peerReview: PeerReviewController;
  queryPeer: QueryPeerController;
  listPeers: ListPeersController;
  countTokens: CountTokensController;
}

function collectTierTimeouts(
  sources: readonly SourceConfig[],
  defaultTimeoutMs: number,
): Record<number, number> {
  return sources.reduce<Record<number, number>>((timeouts, source) => {
    timeouts[source.tier] = Math.max(timeouts[source.tier] ?? 0, source.timeoutMs ?? defaultTimeoutMs);
    return timeouts;
  }, {});
}

function toPeerSource(
  source: SourceConfig,
  env: EnvConfig,
  limits: AdapterLimits,
  logger: ILogger,
): PeerSource {
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
}

function buildSources(logger: ILogger): BuiltSources {
  const env = loadEnvConfig();
  const config = loadPeerConfig(env.configPath);
  // Fail fast if the full sequential escalation path cannot fit the deadline.
  validateTimeoutsAgainstDeadline(config, env);
  const limits = { timeoutMs: env.timeoutMs, maxOutputTokens: env.maxOutputTokens };
  const arbiterConfig = config.sources.find((s) => s.name === config.arbiter);
  const arbiterTimeoutMs = arbiterConfig?.timeoutMs ?? env.timeoutMs;
  const tierTimeoutMs = collectTierTimeouts(config.sources, env.timeoutMs);

  const sources: PeerSource[] = config.sources.map((source) =>
    toPeerSource(source, env, limits, logger),
  );

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
    callerTimeoutMs: env.callerTimeoutMs,
    callerCeiling: callerCeilingMismatch(env),
  };
}

interface ControllerDeps {
  sources: PeerSource[];
  arbiter: PeerSource;
  thresholds: Readonly<Record<number, number>>;
  deadlineMs: number;
  arbiterTimeoutMs: number;
  tierTimeoutMs: Readonly<Record<number, number>>;
  skipLocal: boolean;
  callerTimeoutMs: number;
  callerCeiling: CallerCeiling | undefined;
  logger: ILogger;
}

function buildControllers(deps: ControllerDeps): Controllers {
  const {
    sources,
    arbiter,
    thresholds,
    deadlineMs,
    arbiterTimeoutMs,
    tierTimeoutMs,
    skipLocal,
    callerTimeoutMs,
    callerCeiling,
    logger,
  } = deps;
  return {
    peerReview: new PeerReviewController(
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
      callerCeiling,
    ),
    queryPeer: new QueryPeerController(
      new QueryPeerUseCase(sources, deadlineMs, callerTimeoutMs),
      callerCeiling,
    ),
    listPeers: new ListPeersController(new ListPeersUseCase(sources, callerCeiling)),
    countTokens: new CountTokensController(new CountTokensUseCase(sources), callerCeiling),
  };
}

function registerTools(registry: ToolRegistry, controllers: Controllers): void {
  registry.register(peerReviewTool.name, {
    tool: peerReviewTool,
    handler: (args, signal) => controllers.peerReview.handle(args, signal),
  });
  registry.register(queryPeerTool.name, {
    tool: queryPeerTool,
    handler: (args, signal) => controllers.queryPeer.handle(args, signal),
  });
  registry.register(listPeersTool.name, {
    tool: listPeersTool,
    handler: (args) => controllers.listPeers.handle(args),
  });
  registry.register(countTokensTool.name, {
    tool: countTokensTool,
    handler: (args) => controllers.countTokens.handle(args),
  });
}

async function main(): Promise<void> {
  const logLevel = process.env['LOG_LEVEL'] ?? 'info';
  const logger = createLogger(logLevel);

  const {
    sources,
    arbiterName,
    deadlineMs,
    arbiterTimeoutMs,
    tierTimeoutMs,
    skipLocal,
    thresholds,
    callerTimeoutMs,
    callerCeiling,
  } = buildSources(logger);
  if (callerCeiling !== undefined) {
    // Exactly one startup warning naming both numbers and the two fixes; the
    // server keeps serving — a slow-but-working server must not die at boot.
    logger.warn(`Caller ceiling mismatch: ${callerCeiling.fix}`, {
      PEER_REVIEW_DEADLINE_MS: callerCeiling.deadlineMs,
      PEER_REVIEW_CALLER_TIMEOUT_MS: callerCeiling.callerTimeoutMs,
    });
  }
  const arbiter = sources.find((source) => source.name === arbiterName);
  if (arbiter === undefined) {
    throw new ConfigurationError(`Arbiter "${arbiterName}" not found among built sources`);
  }

  const controllers = buildControllers({
    sources,
    arbiter,
    thresholds,
    deadlineMs,
    arbiterTimeoutMs,
    tierTimeoutMs,
    skipLocal,
    callerTimeoutMs,
    callerCeiling,
    logger,
  });

  const registry = new ToolRegistry();
  registerTools(registry, controllers);

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
