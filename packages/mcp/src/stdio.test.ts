import { describe, it, expect } from 'vitest';
import { MCPRegistry } from './registry.js';
import { normalizeMcpServers } from './config.js';

const fixture = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  if (m.method === 'tools/list') result = m.params?.cursor
    ? { tools: [{ name: 'fail', inputSchema: { type: 'object' } }] }
    : { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object' } }], nextCursor: 'page2' };
  if (m.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(m.params.arguments) }], isError: m.params.name === 'fail' };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`;

describe('standard MCP configuration', () => {
  it('preserves stdio args, environment and working directory', () => {
    const [config] = normalizeMcpServers({ mcpServers: { godot: { command: 'uvx', args: ['--from', 'git+https://example.com/repo', 'godot-ai'], env: { EXAMPLE: 'value' }, cwd: 'M:/project' } } });
    expect(config).toMatchObject({ id: 'godot', transport: 'stdio', command: 'uvx', enabled: true, env: { EXAMPLE: 'value' }, cwd: 'M:/project' });
    expect(normalizeMcpServers(JSON.parse(JSON.stringify([config])))).toEqual([config]);
  });
  it('rejects invalid configs rather than silently deleting servers', () => {
    for (const config of [null, {}, { mcpServers: { a: { command: 'uvx', args: 'bad' } } }, { mcpServers: { a: { command: 'uvx', env: { KEY: 2 } } } }]) {
      expect(() => normalizeMcpServers(config)).toThrow();
    }
    expect(() => normalizeMcpServers([{ id: 'x', name: 'x', url: 'file:///tmp/a' }])).toThrow();
  });
});

describe('stdio MCP lifecycle', () => {
  it('initializes, discovers paginated tools, calls tools and stops disabled processes', async () => {
    const registry = new MCPRegistry();
    const config = normalizeMcpServers({ mcpServers: { fixture: { command: process.execPath, args: ['-e', fixture] } } })[0]!;
    try {
      await registry.syncServers([config]);
      expect(registry.getServerStatus()[0]).toMatchObject({ connected: true, tools: 2 });
      const result = await registry.callTool('echo', { text: 'hello' }, 'fixture');
      expect(result.success).toBe(true);
      expect(JSON.stringify(result.data)).toContain('hello');
      expect((await registry.callTool('fail', {}, 'fixture')).success).toBe(false);
      await registry.syncServers([{ ...config, enabled: false }]);
      expect(registry.listTools()).toEqual([]);
      expect(registry.getServerStatus()[0]?.connected).toBe(false);
      expect((await registry.callTool('echo', {}, 'fixture')).success).toBe(false);
    } finally { await registry.shutdown(); }
  }, 15000);
  it('reports missing executables without breaking other server configuration', async () => {
    const registry = new MCPRegistry();
    try {
      await registry.syncServers(normalizeMcpServers({ mcpServers: { missing: { command: 'ducki-mcp-missing-executable-123456' } } }));
      expect(registry.getServerStatus()[0]).toMatchObject({ connected: false, tools: 0 });
      expect(registry.getServerStatus()[0]?.error).toBeTruthy();
    } finally { await registry.shutdown(); }
  });
});
