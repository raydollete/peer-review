import { ToolRegistry } from '../tool-registry.js';
import { executeToolCall } from '../mcp-server.js';
import {
  peerReviewTool,
  queryPeerTool,
  listPeersTool,
  countTokensTool,
} from '../tools/peer-review.tool.js';
import type { ILogger } from '../../../shared/logger/index.js';
import { errorResponse, successResponse } from '../../../shared/types/index.js';
import { PeerReviewController } from '../../controllers/index.js';
import { PeerReviewQuorumUseCase } from '../../../domain/use-cases/index.js';
import { makeSource, makeArbiter, answers, resolvesOnAbortOnly } from '../../../domain/use-cases/__tests__/helpers.js';

const silentLogger: ILogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
};

function parseEnvelope(result: { content: Array<{ type: string; text: string }> }): {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    cause?: string;
    source?: string;
    detail?: string;
    fix?: string;
    context?: Record<string, unknown>;
  };
} {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe('text');
  return JSON.parse(result.content[0]!.text);
}

describe('tool registry', () => {
  it('registers and lists all four tools', () => {
    const registry = new ToolRegistry();
    for (const tool of [peerReviewTool, queryPeerTool, listPeersTool, countTokensTool]) {
      registry.register(tool.name, { tool, handler: async () => ({}) });
    }
    expect(registry.listTools().map((t) => t.name)).toEqual([
      'peer_review',
      'query_peer',
      'list_peers',
      'count_tokens',
    ]);
    expect(
      Object.fromEntries(
        registry.listTools().map((t) => [t.name, t.annotations]),
      ),
    ).toEqual({
      peer_review: { readOnlyHint: true, openWorldHint: true },
      query_peer: { readOnlyHint: true, openWorldHint: true },
      list_peers: { readOnlyHint: true, openWorldHint: false },
      count_tokens: { readOnlyHint: true, openWorldHint: true },
    });
    expect(registry.has('peer_review')).toBe(true);
  });

  it('exposes callerAnswer on peer_review with blind-to-peers semantics, and not on query_peer', () => {
    const properties = peerReviewTool.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    expect(properties['callerAnswer']?.description).toContain('Never shown to peers');
    expect(peerReviewTool.inputSchema.required).toEqual(['prompt']);
    expect(queryPeerTool.inputSchema.properties).not.toHaveProperty('callerAnswer');
  });
});

describe('executeToolCall', () => {
  it('stringifies the handler result into a single text content block', async () => {
    const registry = new ToolRegistry();
    registry.register('echo', {
      tool: { name: 'echo', description: 'd', inputSchema: { type: 'object' } },
      handler: async (args) => ({ success: true, data: args }),
    });
    const result = await executeToolCall(registry, silentLogger, 'echo', { x: 1 });
    const envelope = parseEnvelope(result);
    expect(envelope).toEqual({ success: true, data: { x: 1 } });
  });

  it('returns TOOL_NOT_FOUND for an unknown tool', async () => {
    const result = await executeToolCall(new ToolRegistry(), silentLogger, 'nope', {});
    const envelope = parseEnvelope(result);
    expect(envelope.success).toBe(false);
    expect(envelope.error?.code).toBe('TOOL_NOT_FOUND');
  });

  it('maps a handler throw to a generic INTERNAL_ERROR', async () => {
    const registry = new ToolRegistry();
    registry.register('boom', {
      tool: { name: 'boom', description: 'd', inputSchema: { type: 'object' } },
      handler: async () => {
        throw new Error('secret internal detail');
      },
    });
    const result = await executeToolCall(registry, silentLogger, 'boom', {});
    const envelope = parseEnvelope(result);
    expect(envelope.success).toBe(false);
    expect(envelope.error?.code).toBe('INTERNAL_ERROR');
    expect(envelope.error?.message).not.toContain('secret internal detail');
  });
});

/** Sorted, de-duplicated key paths with array indices normalized to [*]. */
function keyPaths(value: unknown, prefix = ''): string[] {
  const child = (key: string): string => (prefix === '' ? key : `${prefix}.${key}`);
  const self = prefix === '' || prefix.endsWith('[*]') ? [] : [prefix];
  if (Array.isArray(value)) {
    return [...self, ...new Set(value.flatMap((item) => keyPaths(item, `${prefix}[*]`)))].sort();
  }
  if (typeof value === 'object' && value !== null) {
    return [
      ...self,
      ...Object.entries(value).flatMap(([key, item]) => keyPaths(item, child(key))),
    ].sort();
  }
  return self;
}

const echoTool = { name: 'plain', description: 'd', inputSchema: { type: 'object' } };

describe('failure envelope contract (report-peer-review-failure-cause-and-fix)', () => {
  it('serializes a two-argument errorResponse with exactly code and message', async () => {
    const registry = new ToolRegistry();
    registry.register('plain', {
      tool: echoTool,
      handler: async () => errorResponse('X_ERROR', 'plain message'),
    });
    const result = await executeToolCall(registry, silentLogger, 'plain', {});
    const envelope = parseEnvelope(result);
    expect(Object.keys(envelope.error ?? {}).sort()).toEqual(['code', 'message']);
  });

  it('pins the redacted catch-all: cause internal, fix names the stderr log', async () => {
    const registry = new ToolRegistry();
    registry.register('boom', {
      tool: { name: 'boom', description: 'd', inputSchema: { type: 'object' } },
      handler: async () => {
        throw new Error('provider said sk-SECRETabc and body {"api_key":"sk-SECRETabc"}');
      },
    });
    const result = await executeToolCall(registry, silentLogger, 'boom', {});
    const envelope = parseEnvelope(result);
    expect(envelope.error?.code).toBe('INTERNAL_ERROR');
    expect(envelope.error?.cause).toBe('internal');
    expect(envelope.error?.fix).toContain('stderr');
    expect(envelope.error?.fix).toContain('LOG_LEVEL=debug');
    expect(typeof envelope.error?.context?.correlationId).toBe('string');
  });

  it('never lets a secret from a thrown error cross the boundary (task 9a)', async () => {
    const registry = new ToolRegistry();
    registry.register('leaky', {
      tool: { name: 'leaky', description: 'd', inputSchema: { type: 'object' } },
      handler: async () => {
        const body = '{"error":{"message":"invalid api key sk-LEAKEDkey123"}}';
        throw new Error(`provider rejected us: ${body}`);
      },
    });
    const result = await executeToolCall(registry, silentLogger, 'leaky', {});
    expect(result.content[0]!.text).not.toContain('sk-LEAKEDkey123');
    expect(result.content[0]!.text).not.toContain('provider rejected us');
  });

  it('keeps the achieved-quorum envelope key set at the pre-change set (task 9b)', async () => {
    const a = makeSource('a', 1, 2, answers('a', 'answer-a'));
    const b = makeSource('b', 1, 2, answers('b', 'answer-b'));
    // A third peer still in flight when a+b meet the bar: the early-abort cancels
    // it, so a cancelled row — the only row that carries `note` — is in the roster.
    const slow = makeSource('slow', 1, 1, resolvesOnAbortOnly);
    const controller = new PeerReviewController(
      new PeerReviewQuorumUseCase({
        sources: [a, b, slow],
        arbiter: makeArbiter([{ a: 0.9, b: 0.9 }]),
        thresholds: { 1: 4 },
        deadlineMs: 5000,
      }),
    );
    const registry = new ToolRegistry();
    registry.register('peer_review', {
      tool: peerReviewTool,
      handler: (args) => controller.handle(args),
    });
    const result = await executeToolCall(registry, silentLogger, 'peer_review', { prompt: 'q' });
    expect(JSON.parse(result.content[0]!.text).success).toBe(true);
    expect(keyPaths(JSON.parse(result.content[0]!.text))).toEqual([
      'data',
      'data.certaintyScore',
      'data.quorum',
      'data.quorum.achieved',
      'data.quorum.agreeingWeight',
      'data.quorum.requiredWeight',
      'data.quorum.sources',
      'data.quorum.sources[*].agreement',
      'data.quorum.sources[*].model',
      'data.quorum.sources[*].name',
      'data.quorum.sources[*].note',
      'data.quorum.sources[*].status',
      'data.quorum.sources[*].weight',
      'data.quorum.tier',
      'data.response',
      'data.tokenUsage',
      'data.tokenUsage.completion',
      'data.tokenUsage.prompt',
      'data.tokenUsage.total',
      'success',
    ]);
  });

  it('passes the caller signal into the handler and logs cancellation with the id (task 11)', async () => {
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger: ILogger = {
      info: () => undefined,
      error: () => undefined,
      warn: (message, context) => {
        warnings.push({ message, ...(context !== undefined ? { context } : {}) });
      },
      debug: () => undefined,
    };
    const caller = new AbortController();
    let sawAbort = false;
    const entered = Promise.withResolvers<void>();
    const registry = new ToolRegistry();
    registry.register('slow', {
      tool: { name: 'slow', description: 'd', inputSchema: { type: 'object' } },
      handler: async (_args, signal) => {
        const waiting = Promise.withResolvers<void>();
        entered.resolve();
        if (signal?.aborted === true) {
          waiting.resolve();
        } else {
          signal?.addEventListener('abort', () => waiting.resolve(), { once: true });
        }
        await waiting.promise;
        sawAbort = signal?.aborted === true;
        return successResponse({ late: true });
      },
    });
    const pending = executeToolCall(registry, logger, 'slow', {}, { signal: caller.signal, id: 42 });
    // Await the handler's own entry signal — no guessed duration.
    await entered.promise;
    caller.abort();
    await pending;
    expect(sawAbort).toBe(true);
    const cancel = warnings.find((entry) => entry.message === 'Tool invocation cancelled');
    expect(cancel?.context?.id).toBe(42);
    expect(cancel?.context?.tool).toBe('slow');
  });

  it('sets isError only on failed envelopes (task 12)', async () => {
    const registry = new ToolRegistry();
    registry.register('fail', {
      tool: { name: 'fail', description: 'd', inputSchema: { type: 'object' } },
      handler: async () => errorResponse('VALIDATION_ERROR', 'bad input'),
    });
    registry.register('win', {
      tool: { name: 'win', description: 'd', inputSchema: { type: 'object' } },
      handler: async () => successResponse({ x: 1 }),
    });
    const failed = await executeToolCall(registry, silentLogger, 'fail', {});
    expect(failed.isError).toBe(true);
    // Text content stays byte-identical to the pre-isError shape.
    expect(failed.content).toEqual([{ type: 'text', text: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'bad input' } }) }]);
    const won = await executeToolCall(registry, silentLogger, 'win', {});
    expect(won.isError).toBeUndefined();
  });

  it('logs the request id, tier, and a numeric duration per call (task 13)', async () => {
    const infos: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger: ILogger = {
      info: (message, context) => {
        infos.push({ message, ...(context !== undefined ? { context } : {}) });
      },
      error: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
    };
    const registry = new ToolRegistry();
    registry.register('peer_review', {
      tool: peerReviewTool,
      handler: async () => successResponse({ ok: true }),
    });
    await executeToolCall(registry, logger, 'peer_review', { prompt: 'q', tier: 2 }, { id: 7 });
    const line = infos.find((entry) => entry.message === 'Tool invocation');
    expect(line?.context?.id).toBe(7);
    expect(line?.context?.tool).toBe('peer_review');
    expect(line?.context?.tier).toBe(2);
    expect(typeof line?.context?.durationMs).toBe('number');
  });
});
