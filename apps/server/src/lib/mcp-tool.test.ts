import { describe, expect, it, vi } from 'vitest';
import type { MCPRegistry } from '@ducki/mcp';
import { createMcpTool } from './mcp-tool.js';
import { createBridgeToolExecutors } from '../../../../packages/agent/src/tools/tool-search-bridge.js';
import { getRootLogger } from '@ducki/logger';

describe('shared chat and coding MCP tool', () => {
  it('explains the recorded malformed call and succeeds when corrected through tool_call', async () => {
    const callTool = vi.fn().mockResolvedValue({ success: true, data: { sessions: [] } });
    const mcp = createMcpTool({ callTool } as unknown as MCPRegistry);
    const bridge = createBridgeToolExecutors([mcp.definition], name => name === 'mcp' ? mcp : undefined, getRootLogger());
    const toolCall = bridge.find(tool => tool.name === 'tool_call')!;
    const malformed = await toolCall.execute({ tool_name: 'mcp', arguments: { op: 'list', serverId: 'godot-mcp' } });
    expect(malformed.success).toBe(false);
    expect(malformed.error).toContain('"toolName":"session_manage","input":{"op":"list"}');
    expect(callTool).not.toHaveBeenCalled();
    const corrected = await toolCall.execute({ tool_name: 'mcp', arguments: { action: 'call_tool', serverId: 'godot-mcp', toolName: 'session_manage', input: { op: 'list' } } });
    expect(corrected.success).toBe(true);
    expect(callTool).toHaveBeenCalledWith('session_manage', { op: 'list' }, 'godot-mcp');
  });

  it('rejects malformed or misplaced remote arguments without executing them', async () => {
    const callTool = vi.fn();
    const tool = createMcpTool({ callTool } as unknown as MCPRegistry);
    for (const input of [null, [], '{"op":"list"}']) {
      expect((await tool.execute({ action: 'call_tool', toolName: 'session_manage', input })).success).toBe(false);
    }
    expect((await tool.execute({ action: 'call_tool', toolName: 'session_manage', op: 'list' })).success).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('discovers schemas and forwards server-specific calls including failures', async () => {
    const callTool = vi.fn().mockResolvedValue({ success: false, data: { isError: true }, error: 'Application rejected call' });
    const registry = {
      listTools: () => [{ name: 'edit_scene', serverId: 'godot', inputSchema: { type: 'object' } }, { name: 'other', serverId: 'other' }],
      getServerStatus: () => [{ id: 'godot', connected: true, env: { TOKEN: 'secret' } }],
      callTool,
    } as unknown as MCPRegistry;
    const tool = createMcpTool(registry);
    expect(await tool.execute({ action: 'list_tools', serverId: 'godot' })).toMatchObject({ success: true, data: [{ name: 'edit_scene', inputSchema: { type: 'object' } }] });
    expect(JSON.stringify(await tool.execute({ action: 'list_servers' }))).not.toContain('secret');
    expect(await tool.execute({ action: 'call_tool', serverId: 'godot', toolName: 'edit_scene', input: { scene: 'main' } })).toMatchObject({ success: false, error: 'Application rejected call' });
    expect(callTool).toHaveBeenCalledWith('edit_scene', { scene: 'main' }, 'godot');
  });
});
