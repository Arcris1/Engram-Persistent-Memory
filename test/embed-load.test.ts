import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngramConfig } from '../src/config.js';
import { tmpDir } from './helpers.js';

function configWith(embedding: Partial<EngramConfig['embedding']>): EngramConfig {
  return { ingestToolResults: false, embedding: { enabled: false, modelDir: '', sha256: '', ...embedding } };
}

function writeModelFiles(dir: string, content = 'fake-model-bytes'): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model_quantized.onnx'), content);
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), '{}');
  fs.writeFileSync(path.join(dir, 'tokenizer_config.json'), '{}');
  return createHash('sha256').update(content).digest('hex');
}

function refuseImport(name: string) {
  vi.doMock(name, () => {
    throw new Error(`${name} must not be imported on this path`);
  });
}

describe('tryLoadEmbedder / loadEmbedder (D42)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('disabled (default) -> null, reason "disabled", without importing onnxruntime-node or the tokenizer', async () => {
    refuseImport('onnxruntime-node');
    refuseImport('@huggingface/tokenizers');
    const { tryLoadEmbedder, loadEmbedder } = await import('../src/embed/load.js');
    expect(await tryLoadEmbedder(configWith({}))).toEqual({ embedder: null, reason: 'disabled' });
    expect(await loadEmbedder(configWith({}))).toBeNull();
  });

  it('enabled but no modelDir -> null, reason mentions modelDir, no import', async () => {
    refuseImport('onnxruntime-node');
    refuseImport('@huggingface/tokenizers');
    const { tryLoadEmbedder } = await import('../src/embed/load.js');
    const result = await tryLoadEmbedder(configWith({ enabled: true, sha256: 'a'.repeat(64) }));
    expect(result.embedder).toBeNull();
    expect(result.reason).toMatch(/modelDir/);
  });

  it('enabled but no sha256 -> null, reason mentions sha256, no import', async () => {
    refuseImport('onnxruntime-node');
    refuseImport('@huggingface/tokenizers');
    const { tryLoadEmbedder } = await import('../src/embed/load.js');
    const result = await tryLoadEmbedder(configWith({ enabled: true, modelDir: tmpDir() }));
    expect(result.embedder).toBeNull();
    expect(result.reason).toMatch(/sha256/);
  });

  it('relative modelDir (after ~ expansion) -> null, reason says it must be absolute, no import', async () => {
    refuseImport('onnxruntime-node');
    refuseImport('@huggingface/tokenizers');
    const { tryLoadEmbedder } = await import('../src/embed/load.js');
    const result = await tryLoadEmbedder(configWith({ enabled: true, modelDir: 'models/minilm', sha256: 'a'.repeat(64) }));
    expect(result.embedder).toBeNull();
    expect(result.reason).toMatch(/modelDir must be an absolute path/);
    expect(result.reason).toContain('models/minilm');
  });

  it('modelDir missing a required file -> null, reason names it, no import', async () => {
    refuseImport('onnxruntime-node');
    refuseImport('@huggingface/tokenizers');
    const { tryLoadEmbedder } = await import('../src/embed/load.js');
    const dir = tmpDir();
    const result = await tryLoadEmbedder(configWith({ enabled: true, modelDir: dir, sha256: 'a'.repeat(64) }));
    expect(result.embedder).toBeNull();
    expect(result.reason).toContain('model_quantized.onnx');
  });

  it('sha256 mismatch -> null, reason shows expected/got, no import', async () => {
    refuseImport('onnxruntime-node');
    refuseImport('@huggingface/tokenizers');
    const { tryLoadEmbedder } = await import('../src/embed/load.js');
    const dir = tmpDir();
    writeModelFiles(dir);
    const result = await tryLoadEmbedder(configWith({ enabled: true, modelDir: dir, sha256: 'f'.repeat(64) }));
    expect(result.embedder).toBeNull();
    expect(result.reason).toMatch(/sha256 mismatch/);
    expect(result.reason).toContain('f'.repeat(64));
  });

  it('sha256 match -> delegates to onnx.js (mocked) with the resolved model dir', async () => {
    const fakeEmbedder = {
      model: 'mock',
      dim: 4,
      embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(4))),
    };
    const createOnnxEmbedder = vi.fn(async () => fakeEmbedder);
    vi.doMock('../src/embed/onnx.js', () => ({ createOnnxEmbedder }));
    const { tryLoadEmbedder } = await import('../src/embed/load.js');
    const dir = tmpDir();
    const sha = writeModelFiles(dir);
    const result = await tryLoadEmbedder(configWith({ enabled: true, modelDir: dir, sha256: sha }));
    expect(result.reason).toBe('ok');
    expect(result.embedder).toBe(fakeEmbedder);
    // Phase 6 review (model identity): the verified sha256 is passed so the embedder's model string can carry its prefix
    expect(createOnnxEmbedder).toHaveBeenCalledWith(dir, sha);
  });

  it('sha256 comparison is case-insensitive', async () => {
    const fakeEmbedder = { model: 'mock', dim: 4, embed: vi.fn(async () => []) };
    const createOnnxEmbedder = vi.fn(async () => fakeEmbedder);
    vi.doMock('../src/embed/onnx.js', () => ({ createOnnxEmbedder }));
    const { tryLoadEmbedder } = await import('../src/embed/load.js');
    const dir = tmpDir();
    const sha = writeModelFiles(dir);
    const result = await tryLoadEmbedder(configWith({ enabled: true, modelDir: dir, sha256: sha.toUpperCase() }));
    expect(result.reason).toBe('ok');
  });

  it('loadEmbedder logs the reason to stderr when enabled-but-broken, but stays silent when simply disabled', async () => {
    refuseImport('onnxruntime-node');
    refuseImport('@huggingface/tokenizers');
    const { loadEmbedder } = await import('../src/embed/load.js');
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await loadEmbedder(configWith({}));
      expect(spy).not.toHaveBeenCalled();
      await loadEmbedder(configWith({ enabled: true }));
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls.at(-1)?.[0]).toContain('modelDir');
    } finally {
      spy.mockRestore();
    }
  });
});
