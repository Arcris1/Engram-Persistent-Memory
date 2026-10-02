import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer, type ServerOptions } from '../src/mcp/server.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engram-test-'));
}

/** A DB path inside a not-yet-existing directory, so openDb must create it. */
export function tmpDbFile(): string {
  return path.join(tmpDir(), 'engram', 'engram.db');
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export function runCli(
  args: string[],
  opts: { dbFile: string; stdin?: string; env?: Record<string, string> },
): CliResult {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/engram.js'), ...args], {
    input: opts.stdin ?? '',
    encoding: 'utf8',
    env: { ...process.env, ENGRAM_DB: opts.dbFile, ...opts.env },
    timeout: 15_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started };
}

export async function connectInMemory(opts: ServerOptions): Promise<Client> {
  const server = createServer(opts);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'engram-test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content[0]?.text ?? '';
}
