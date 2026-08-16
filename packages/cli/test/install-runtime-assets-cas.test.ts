import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareAndSwapText } from '../src/adapters/settings.js';

import { authorizeWorkspaceBuild } from '../src/install/runtime-assets.js';

vi.mock('../src/adapters/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/settings.js')>();
  return { ...actual, compareAndSwapText: vi.fn() };
});

const roots: string[] = [];

afterEach(async () => {
  vi.mocked(compareAndSwapText).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace build authorization CAS', () => {
  it.each([
    { ok: false, reason: 'changed' },
    { ok: true, value: false },
  ])('fails closed when the reviewed workspace bytes do not commit: %#', async (result) => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-workspace-cas-'));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\n');
    vi.mocked(compareAndSwapText).mockResolvedValue(result as never);
    await expect(authorizeWorkspaceBuild(root, 'exact-package')).rejects.toMatchObject({
      code: 'E_WORKSPACE_CHANGED',
    });
  });
});
