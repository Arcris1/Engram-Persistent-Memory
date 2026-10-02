import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, tmpDbFile, tmpDir } from './helpers.js';

/**
 * Phase 6 minor (C1): hook processes must never load src/embed/* nor the optional ML packages.
 *
 * Mechanism: spawn the real bin/engram.js with `node --import <register.mjs>`. register.mjs installs
 * an ESM resolve hook (module.register) that appends every resolved URL to a log file. Unlike
 * require.cache this sees ESM imports, and unlike NODE_DEBUG it is a stable public API. The test
 * then asserts the log has no dist/embed/ module and no onnxruntime-node / @huggingface/tokenizers.
 */
function loadedModules(args: string[], stdin: string): string[] {
  const dir = tmpDir();
  const log = path.join(dir, 'resolved.log');
  const hooks = path.join(dir, 'hooks.mjs');
  const register = path.join(dir, 'register.mjs');
  fs.writeFileSync(
    hooks,
    `import fs from 'node:fs';
export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  fs.appendFileSync(${JSON.stringify(log)}, r.url + '\\n');
  return r;
}
`,
  );
  fs.writeFileSync(
    register,
    `import { register } from 'node:module';
register(${JSON.stringify('file://' + hooks)});
`,
  );
  const r = spawnSync(process.execPath, ['--import', register, path.join(ROOT, 'bin/engram.js'), ...args], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ENGRAM_DB: tmpDbFile(), HOME: dir },
    timeout: 20_000,
  });
  expect(r.status).toBe(0);
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

const hookJson = JSON.stringify({
  session_id: 'sess-lazy',
  cwd: ROOT,
  transcript_path: '/dev/null',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'hello',
});

describe('hook processes do not load embedding code (Phase 6 review)', () => {
  for (const cmd of ['session-start', 'ingest-prompt', 'ingest-transcript', 'session-end']) {
    it(`${cmd} loads no dist/embed module, onnxruntime-node or @huggingface/tokenizers`, () => {
      const urls = loadedModules([cmd], hookJson);
      // sanity: the hook actually ran through our own code, so an empty log can't pass vacuously
      expect(urls.some((u) => u.includes('/dist/cli/main.js'))).toBe(true);
      expect(urls.filter((u) => u.includes('/dist/embed/'))).toEqual([]);
      expect(urls.filter((u) => /onnxruntime-node|@huggingface\/tokenizers/.test(u))).toEqual([]);
    });
  }
});

describe('hook processes do not load the UI seam (D45)', () => {
  for (const cmd of ['session-start', 'ingest-prompt', 'ingest-transcript', 'session-end']) {
    it(`${cmd} loads no dist/api.js, dist/cli/commands/ui.js or anything under ui/`, () => {
      const urls = loadedModules([cmd], hookJson);
      expect(urls.some((u) => u.includes('/dist/cli/main.js'))).toBe(true);
      expect(urls.filter((u) => u.endsWith('/dist/api.js'))).toEqual([]);
      expect(urls.filter((u) => u.endsWith('/dist/cli/commands/ui.js'))).toEqual([]);
      // dist/control/list.js is fine: `engram list` (and so the control module) is shared core code.
      expect(urls.filter((u) => u.startsWith(`file://${ROOT}/ui/`))).toEqual([]);
    });
  }
});
