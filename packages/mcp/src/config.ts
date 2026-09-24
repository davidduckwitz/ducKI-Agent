import type { MCPServerConfig } from './registry.js';

/** Accept both ducki's persisted array and the standard mcpServers config. */
export function normalizeMcpServers(value: unknown): MCPServerConfig[] {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  let entries: unknown[];
  if (Array.isArray(value)) entries = value;
  else if (object(value) && object(value.mcpServers)) {
    entries = Object.entries(value.mcpServers).map(([id, config]) => {
      if (!object(config)) throw new Error(`Invalid MCP server: ${id}`);
      return { ...config, id, name: id };
    });
  } else throw new Error('Expected a server array or { mcpServers: { ... } }');
  const ids = new Set<string>();
  return entries.map((entry) => {
    if (!object(entry)) throw new Error('Invalid MCP server');
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : id;
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !name || ids.has(id)) throw new Error(`Invalid or duplicate MCP id: ${id}`);
    ids.add(id);
    const transport = entry.transport ?? (entry.command ? 'stdio' : 'legacy-http');
    if (!['stdio', 'http', 'legacy-http'].includes(String(transport))) throw new Error(`Invalid transport: ${transport}`);
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('enabled must be boolean');
    const base = { id, name, enabled: entry.enabled !== false };
    if (transport === 'stdio') {
      if (typeof entry.command !== 'string' || !entry.command.trim()) throw new Error('stdio requires command');
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(a => typeof a !== 'string'))) throw new Error('args must be a string array');
      if (entry.env !== undefined && (!object(entry.env) || Object.values(entry.env).some(v => typeof v !== 'string'))) throw new Error('env must contain string values');
      if (entry.cwd !== undefined && typeof entry.cwd !== 'string') throw new Error('cwd must be a string');
      return { ...base, transport: 'stdio', url: '', command: entry.command.trim(), args: (entry.args ?? []) as string[], env: entry.env as Record<string, string> | undefined, cwd: entry.cwd as string | undefined };
    }
    if (typeof entry.url !== 'string' || !/^https?:$/.test(new URL(entry.url).protocol)) throw new Error('HTTP requires an http(s) URL');
    return { ...base, transport: transport as 'http' | 'legacy-http', url: entry.url.trim() };
  });
}
