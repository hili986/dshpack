import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../..');
const generate = resolve(repository, 'scripts/generate-pack-schemas.mjs');
const verify = resolve(repository, 'scripts/verify-pack-schema.mjs');
const packSchema = resolve(repository, 'schemas/pack.schema.json');
const lockSchema = resolve(repository, 'schemas/pack-lock.schema.json');

function node(script: string): string {
  const run = spawnSync(process.execPath, [script], { cwd: repository, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout;
}

describe('published schema artifacts', () => {
  it('generates draft 2020-12 JSON schemas from the TypeBox truth source', async () => {
    expect(node(generate)).toContain('generated');
    const pack = JSON.parse(await readFile(packSchema, 'utf8')) as Record<string, unknown>;
    const lock = JSON.parse(await readFile(lockSchema, 'utf8')) as Record<string, unknown>;
    expect(pack.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(lock.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(node(verify)).toContain('verified');
  });

  it('turns red when a published schema drifts and green after regeneration', async () => {
    const original = await readFile(packSchema, 'utf8');
    try {
      await writeFile(packSchema, '{}\n', 'utf8');
      expect(() => node(verify)).toThrow(/schema drift/u);
    } finally {
      await writeFile(packSchema, original, 'utf8');
      node(generate);
    }
    expect(node(verify)).toContain('verified');
  });
});
