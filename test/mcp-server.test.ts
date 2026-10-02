import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/storage/db.js';
import { StatsSchema } from '../src/storage/stats.js';
import { connectInMemory, ROOT, textOf, tmpDbFile } from './helpers.js';

describe('engram MCP server', () => {
  it('lists memory_stats and returns text + structuredContent', async () => {
    const dbFile = tmpDbFile();
    const client = await connectInMemory({ db: openDb(dbFile), dbFile });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('memory_stats');
    const result = await client.callTool({ name: 'memory_stats', arguments: {} });
    expect(textOf(result)).toContain('events:    0');
    expect(StatsSchema.parse(result.structuredContent).events).toBe(0);
    await client.close();
  });

  it('starts over stdio and answers tools/list (Phase 0 acceptance)', async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, 'bin/engram-mcp.js')],
      env: { ...env, ENGRAM_DB: tmpDbFile() },
    });
    const client = new Client({ name: 'engram-test', version: '0.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('memory_stats');
    await client.close();
  });
});
