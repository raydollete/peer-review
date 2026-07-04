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
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/** Envelope semantics: unknown tool → TOOL_NOT_FOUND; handler throw → generic INTERNAL_ERROR. */
export async function executeToolCall(
  registry: ToolRegistry,
  logger: ILogger,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const toolDef = registry.get(name);
  if (toolDef === undefined) {
    return textContent(errorResponse('TOOL_NOT_FOUND', `Tool not found: ${name}`));
  }
  try {
    const result = await toolDef.handler(args);
    return textContent(result);
  } catch (error) {
    logger.error('Tool execution error', { tool: name, error: String(error) });
    return textContent(errorResponse('INTERNAL_ERROR', 'An internal error occurred'));
  }
}

export class McpServer {
  private readonly server: Server;

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly logger: ILogger,
  ) {
    this.server = new Server(
      { name: 'peer-review-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.logger.debug('Received tools/list request');
      return { tools: this.toolRegistry.listTools() };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      this.logger.info('Tool invocation', { tool: name });
      return executeToolCall(this.toolRegistry, this.logger, name, args);
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('MCP server started');
  }
}
