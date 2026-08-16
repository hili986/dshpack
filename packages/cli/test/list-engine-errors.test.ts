import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const safe = vi.hoisted(() => ({
  bindSecureRoot: vi.fn(),
  readDirectory: vi.fn(),
}));

vi.mock('../src/list/safe-fs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/list/safe-fs.js')>()),
  bindSecureRoot: safe.bindSecureRoot,
  readDirectory: safe.readDirectory,
}));

import { listProfiles } from '../src/list/engine.js';

const root = {
  rootPath: resolve('fixture-home'),
  rootCanonical: resolve('fixture-home'),
  entries: [
    {
      path: resolve('fixture-home'),
      canonical: resolve('fixture-home'),
      identity: 'fixture',
    },
  ],
};

beforeEach(() => {
  safe.bindSecureRoot.mockReset();
  safe.readDirectory.mockReset();
  safe.bindSecureRoot.mockResolvedValue({ ok: true, value: root });
});

describe('list IO error mapping', () => {
  it('maps an unreadable DSH_HOME root to environment exit 10', async () => {
    safe.bindSecureRoot.mockResolvedValue({ ok: false, kind: 'io', reason: 'denied' });
    await expect(listProfiles({ dshHome: root.rootPath })).resolves.toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_LIST_DSH_HOME' })],
    });
  });

  it('maps unreadable profile and marker directories without throwing', async () => {
    safe.readDirectory.mockResolvedValueOnce({ ok: false, kind: 'io', reason: 'profiles denied' });
    await expect(listProfiles({ dshHome: root.rootPath })).resolves.toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_LIST_PROFILES' })],
    });

    safe.readDirectory
      .mockResolvedValueOnce({ ok: true, value: [] })
      .mockResolvedValueOnce({ ok: false, kind: 'io', reason: 'markers denied' });
    await expect(listProfiles({ dshHome: root.rootPath })).resolves.toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_LIST_METADATA' })],
    });
  });
});
