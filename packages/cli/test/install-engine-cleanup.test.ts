import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { c as createTar } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

import { materializeSource } from '../src/adapters/source.js';
import { diagnostic } from '../src/commands/shared.js';
import { installPack } from '../src/install/engine.js';
import { cleanupEnginePackFixtures, enginePack, fakeRuntime } from './install-engine-fixture.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-engine-cleanup-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('install source cleanup terminal matrix', () => {
  it('removes every fixture-owned source temp without treating it as runtime cleanup', async () => {
    const first = await enginePack();
    const second = await enginePack();
    await cleanupEnginePackFixtures();
    await expect(access(first)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(second)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    'validation',
    'prompt',
    'success',
    'rollback',
    'read-throw',
    'cleanup-failure',
  ] as const)('runs acquired source cleanup exactly once after %s', async (terminal) => {
    const fake = fakeRuntime({
      ...(terminal === 'prompt' ? { confirmations: [false] } : {}),
      ...(terminal === 'rollback' ? { fault: 'doctor' as const } : {}),
    });
    if (terminal === 'validation') {
      fake.runtime.readValidatedPack = async () => ({
        diagnostics: [diagnostic('E_VALIDATION', 'error', 'invalid pack', 'fix pack')],
        exitCode: 30,
      });
    } else if (terminal === 'read-throw') {
      fake.runtime.readValidatedPack = async () => {
        throw new Error('read mutant');
      };
    } else if (terminal === 'cleanup-failure') {
      const acquire = fake.runtime.materializeSource;
      fake.runtime.materializeSource = async (reference) => {
        const source = await acquire(reference);
        return {
          ...source,
          async cleanup() {
            await source.cleanup();
            throw new Error('cleanup mutant');
          },
        };
      };
    }
    const result = await installPack(
      {
        source: await enginePack(),
        dshHome: await home(),
        interactive: terminal === 'prompt',
        ...(terminal === 'prompt' ? {} : { yes: true }),
      },
      fake.runtime,
    );
    expect(fake.calls.filter((call) => call === 'cleanup:source')).toHaveLength(1);
    expect(result.metadata.status).toBe(
      terminal === 'success'
        ? 'installed'
        : terminal === 'rollback'
          ? 'rolled-back'
          : 'not-started',
    );
  });

  it('removes the real private archive workspace before the first install write', async () => {
    const sourceDirectory = await enginePack();
    const dshHome = await home();
    const archive = join(dshHome, 'fixture.dshpack.tgz');
    await createTar(
      { cwd: sourceDirectory, file: archive, gzip: true, portable: true },
      await readdir(sourceDirectory),
    );
    const fake = fakeRuntime();
    let privateDirectory = '';
    fake.runtime.materializeSource = async (reference) => {
      const source = await materializeSource(reference);
      privateDirectory = source.directory;
      return source;
    };

    const result = await installPack(
      { source: archive, dshHome, yes: true, interactive: false },
      fake.runtime,
    );

    expect(result.exitCode).toBe(0);
    expect(privateDirectory).not.toBe('');
    await expect(access(privateDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
