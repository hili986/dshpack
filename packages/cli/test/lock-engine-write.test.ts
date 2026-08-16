import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const adapters = vi.hoisted(() => ({ writeFileAtomic: vi.fn() }));

vi.mock('../src/adapters/fs.js', () => adapters);

import { generateAndWriteLock } from '../src/lock/engine.js';

async function makePack(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-lock-write-test-'));
  await mkdir(join(root, 'patch'), { recursive: true });
  await writeFile(
    join(root, 'pack.yml'),
    'formatVersion: 0\nname: lock-write-fixture\nversion: 0.1.0\ndescription: fixture\nauthor: fixture\nlicense: MIT\ndsh:\n  tested: [0.1.0-rc.6]\nplugins: []\nmcp: []\ndefaults:\n  permissionPreset: workspace-write\n',
    'utf8',
  );
  await writeFile(join(root, 'patch', 'cordis.patch.yml'), '[]\n', 'utf8');
  return root;
}

describe('lock write failure boundary', () => {
  it('turns an atomic pack.lock.yml write failure into E_LOCK_WRITE', async () => {
    const root = await makePack();
    adapters.writeFileAtomic.mockRejectedValueOnce(new Error('synthetic atomic write failure'));

    try {
      await expect(generateAndWriteLock(root)).resolves.toMatchObject({
        exitCode: 30,
        diagnostics: [expect.objectContaining({ code: 'E_LOCK_WRITE' })],
        metadata: { written: false },
      });
      expect(adapters.writeFileAtomic).toHaveBeenCalledWith(
        join(root, 'pack.lock.yml'),
        expect.any(String),
        { mode: 0o600 },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      adapters.writeFileAtomic.mockReset();
    }
  });
});
