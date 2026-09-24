import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolResult } from '@ducki/shared';
import type { MCPServerConfig } from './registry.js';
import type { MCPTool } from './client.js';

export class MCPSdkClient {
  private client = new Client({ name: 'ducki-node', version: '0.1.0' });
  private tools: MCPTool[] = [];
  private connected = false;
  private error?: string;
  constructor(private config: MCPServerConfig) {}
  async connect(): Promise<void> {
    this.client.onclose = () => { this.connected = false; this.tools = []; };
    this.client.onerror = error => { this.error = error.message; };
    try {
      const transport = this.config.transport === 'stdio'
        ? new StdioClientTransport({ command: this.config.command!, args: this.config.args, env: this.config.env, cwd: this.config.cwd, stderr: 'ignore' })
        : new StreamableHTTPClientTransport(new URL(this.config.url));
      await this.client.connect(transport, { timeout: 60000 });
      const tools: MCPTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await this.client.listTools({ cursor });
        tools.push(...page.tools.map(tool => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, serverId: this.config.id })));
        cursor = page.nextCursor;
      } while (cursor);
      this.tools = tools;
      this.connected = true;
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      await this.disconnect();
    }
  }
  async disconnect() { this.connected = false; this.tools = []; await this.client.close(); }
  isConnected() { return this.connected; }
  getReconnectAttempts() { return 0; }
  getLastError() { return this.error; }
  listTools() { return this.tools; }
  getToolDefinitions() { return this.tools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema })); }
  async callTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    if (!this.connected) return { success: false, data: null, error: this.error ?? 'MCP disconnected' };
    try {
      const result = await this.client.callTool({ name, arguments: input });
      return { success: !result.isError, data: result, ...(result.isError ? { error: JSON.stringify(result.content) } : {}) };
    } catch (error) { return { success: false, data: null, error: error instanceof Error ? error.message : String(error) }; }
  }
  async *streamTool(name: string, input: Record<string, unknown>) { yield JSON.stringify(await this.callTool(name, input)); }
}
