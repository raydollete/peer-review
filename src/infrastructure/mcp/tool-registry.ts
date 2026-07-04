import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ToolHandler {
  (args: unknown): Promise<unknown>;
}

export interface ToolDefinition {
  readonly tool: Tool;
  readonly handler: ToolHandler;
}

export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition> = new Map();

  register(name: string, definition: ToolDefinition): void {
    this.tools.set(name, definition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  listTools(): Tool[] {
    return Array.from(this.tools.values()).map((def) => def.tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
