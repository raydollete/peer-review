import { ToolRegistry } from '../tool-registry.js';
import { executeToolCall } from '../mcp-server.js';
import {
  peerReviewTool,
  queryPeerTool,
  listPeersTool,
  countTokensTool,
} from '../tools/peer-review.tool.js';
import type { ILogger } from '../../../shared/logger/index.js';

const silentLogger: ILogger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
};

function parseEnvelope(result: { content: Array<{ type: string; text: string }> }): {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
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
    expect(registry.has('peer_review')).toBe(true);
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
