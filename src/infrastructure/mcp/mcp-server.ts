import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ILogger } from '../../shared/logger/index.js';
import { errorResponse } from '../../shared/types/index.js';

function textContent(payload: unknown): CallToolResult {
  const failed =
    typeof payload === 'object' &&
    payload !== null &&
    'success' in payload &&
    payload.success === false;
  const result: CallToolResult = {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
  if (failed) {
    // Say "error" in the protocol too: a harness that does not parse the JSON
    // text still sees a failure rather than ordinary content.
    result.isError = true;
  }
  return result;
}

export interface ToolCallRun {
  /** The SDK's cancellation signal (notifications/cancelled from the caller). */
  readonly signal?: AbortSignal;
  /** The JSON-RPC request id, logged so "answered after the caller left" is measurable. */
  readonly id?: string | number;
}

/** Envelope semantics: unknown tool → TOOL_NOT_FOUND; handler throw → generic
 * redacted INTERNAL_ERROR with cause 'internal' and a fix pointing at stderr. */
export async function executeToolCall(
  registry: ToolRegistry,
  logger: ILogger,
  name: string,
  args: unknown,
  run?: ToolCallRun,
): Promise<CallToolResult> {
  const id = run?.id;
  const toolDef = registry.get(name);
  if (toolDef === undefined) {
    return textContent(
      errorResponse('TOOL_NOT_FOUND', `Tool not found: ${name}`, {
        cause: 'validation',
        fix: 'Call a registered tool; use tools/list to enumerate them',
      }),
    );
  }
  const start = Date.now();
  try {
    // Pass the caller's signal into the run so an abandon aborts it instead of
    // billing peers to the wall.
    const result = await toolDef.handler(args, run?.signal);
    if (run?.signal?.aborted === true) {
      logger.warn('Tool invocation cancelled', { tool: name, ...(id !== undefined ? { id } : {}) });
    }
    logger.info('Tool invocation', {
      tool: name,
      ...(id !== undefined ? { id } : {}),
      ...tierContext(args),
      durationMs: Date.now() - start,
    });
    return textContent(result);
  } catch (error) {
    // Redacted catch-all: the thrown message, any upstream body, and any secret
    // never cross the boundary. The full error goes to the stderr log beside a
    // correlationId the envelope carries, so the caller is pointed at evidence.
    const correlationId = randomUUID();
    logger.error('Tool execution error', { tool: name, correlationId, error: String(error) });
    return textContent(
      errorResponse('INTERNAL_ERROR', 'An internal error occurred', {
        cause: 'internal',
        fix: `Inspect the peer-review server stderr log for correlationId ${correlationId}; rerun with LOG_LEVEL=debug for the full error`,
        context: { correlationId },
      }),
    );
  }
}

function tierContext(args: unknown): { tier?: number } {
  if (typeof args === 'object' && args !== null && 'tier' in args) {
    const { tier } = args;
    if (typeof tier === 'number') {
      return { tier };
    }
  }
  return {};
}

export class McpServer {
  private readonly server: Server;

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly logger: ILogger,
  ) {
    this.server = new Server(
      { name: 'peer-review-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.debug('Received tools/list request');
      return { tools: this.toolRegistry.listTools() };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      return executeToolCall(this.toolRegistry, this.logger, name, args, {
        signal: extra.signal,
        id: extra.requestId,
      });
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('MCP server started');
  }
}
