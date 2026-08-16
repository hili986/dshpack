import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nodeTransactionAdapter, runTransaction } from '../src/transaction.js';

async function withTemporaryRoot(
  operation: (root: string, dshHome: string) => Promise<void>,
): Promise<void> {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'dshpack-transaction-scope-'));
  if (dirname(root) !== parent) throw new Error(`unsafe temporary path: ${root}`);
  try {
    await operation(root, join(root, 'home'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function expectScopeFailure(
  result: Awaited<ReturnType<typeof runTransaction>>,
  code: string,
  path: string,
): void {
  expect(result).toMatchObject({
    ok: false,
    status: 'rolled-back',
    exitCode: 31,
    journal: { actions: [] },
  });
  expect(result.diagnostics[0]).toMatchObject({ code, path });
}

describe('transaction mutation path scope', () => {
  it('rejects out-of-home create before reserving or invoking apply', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const outside = join(root, 'outside-skill');
      let applyEntered = false;
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'outside-create' },
        async (transaction) => {
          await transaction.create('skill', outside, async () => {
            applyEntered = true;
            await writeFile(join(outside, 'SKILL.md'), '# escaped\n', 'utf8');
          });
        },
      );

      expectScopeFailure(result, 'E_TRANSACTION_ARTIFACT_PATH_SCOPE', outside);
      expect(applyEntered).toBe(false);
      expect(await nodeTransactionAdapter.pathExists(outside)).toBe(false);
    });
  });

  it('rejects out-of-home replace without moving the existing profile', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const outside = join(root, 'outside-profile');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'package.json'), '{"name":"outside"}\n', 'utf8');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'outside-replace' },
        async (transaction) => transaction.replaceProfile(outside),
      );

      expectScopeFailure(result, 'E_TRANSACTION_ARTIFACT_PATH_SCOPE', outside);
      expect(await readFile(join(outside, 'package.json'), 'utf8')).toBe('{"name":"outside"}\n');
    });
  });

  it('rejects an artifact root junction that escapes DSH_HOME', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const outsideRoot = join(root, 'outside-profiles');
      const outside = join(outsideRoot, 'escaped');
      await mkdir(outside, { recursive: true });
      await mkdir(dshHome, { recursive: true });
      await writeFile(join(outside, 'package.json'), '{"name":"escaped"}\n', 'utf8');
      await symlink(
        outsideRoot,
        join(dshHome, 'profiles'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const alias = join(dshHome, 'profiles', 'escaped');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'junction-replace' },
        async (transaction) => transaction.replaceProfile(alias),
      );

      expectScopeFailure(result, 'E_TRANSACTION_ARTIFACT_PATH_SCOPE', alias);
      expect(await readFile(join(outside, 'package.json'), 'utf8')).toBe('{"name":"escaped"}\n');
    });
  });

  it('rejects a target junction under a normal artifact root', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const outside = join(root, 'outside-target');
      const profiles = join(dshHome, 'profiles');
      const alias = join(profiles, 'linked');
      await mkdir(outside, { recursive: true });
      await mkdir(profiles, { recursive: true });
      await writeFile(join(outside, 'package.json'), '{"name":"linked"}\n', 'utf8');
      await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'junction-target' },
        async (transaction) => transaction.replaceProfile(alias),
      );

      expectScopeFailure(result, 'E_TRANSACTION_ARTIFACT_PATH_SCOPE', alias);
      expect(await readFile(join(outside, 'package.json'), 'utf8')).toBe('{"name":"linked"}\n');
    });
  });

  it('rejects a dangling artifact target link instead of treating it as missing', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const missingTarget = join(root, 'missing-artifact-target');
      const profiles = join(dshHome, 'profiles');
      const alias = join(profiles, 'dangling');
      await mkdir(profiles, { recursive: true });
      await symlink(missingTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'dangling-artifact' },
        async (transaction) => transaction.replaceProfile(alias),
      );

      expectScopeFailure(result, 'E_TRANSACTION_ARTIFACT_PATH_SCOPE', alias);
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      expect(await nodeTransactionAdapter.pathExists(missingTarget)).toBe(false);
    });
  });

  it('rejects a dangling artifact root while checking a missing child', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const missingRoot = join(root, 'missing-profiles-root');
      const profiles = join(dshHome, 'profiles');
      await mkdir(dshHome, { recursive: true });
      await symlink(missingRoot, profiles, process.platform === 'win32' ? 'junction' : 'dir');
      const target = join(profiles, 'child');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'dangling-artifact-root' },
        async (transaction) => transaction.replaceProfile(target),
      );

      expectScopeFailure(result, 'E_TRANSACTION_ARTIFACT_PATH_SCOPE', target);
      expect((await lstat(profiles)).isSymbolicLink()).toBe(true);
      expect(await nodeTransactionAdapter.pathExists(missingRoot)).toBe(false);
    });
  });

  it('allows all documented in-home mutation scopes with the production adapter', async () => {
    await withTemporaryRoot(async (_root, dshHome) => {
      const profile = join(dshHome, 'profiles', 'inside');
      const skill = join(dshHome, 'skills', 'inside');
      const preset = join(dshHome, '.agent-presets', 'inside');
      const settings = join(dshHome, 'settings.yaml');
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, 'package.json'), '{"name":"old"}\n', 'utf8');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'inside-scopes' },
        async (transaction) => {
          await transaction.replaceProfile(profile);
          await transaction.create('profile', profile, async () => {
            await writeFile(join(profile, 'package.json'), '{"name":"new"}\n', 'utf8');
          });
          await transaction.create('skill', skill, async () => {
            await writeFile(join(skill, 'SKILL.md'), '# inside\n', 'utf8');
          });
          await transaction.create('preset', preset, async () => {
            await writeFile(join(preset, 'preset.yml'), 'name: inside\n', 'utf8');
          });
          await transaction.writeSettings(
            settings,
            undefined,
            'agent-presets:\n  default: inside\n',
          );
        },
      );

      expect(result).toMatchObject({ ok: true, status: 'committed', exitCode: 0 });
      expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe('{"name":"new"}\n');
      expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toBe('# inside\n');
      expect(await readFile(join(preset, 'preset.yml'), 'utf8')).toBe('name: inside\n');
      expect(await readFile(settings, 'utf8')).toBe('agent-presets:\n  default: inside\n');
    });
  });

  it('restores an in-home replaced profile through the scoped reverse move', async () => {
    await withTemporaryRoot(async (_root, dshHome) => {
      const profile = join(dshHome, 'profiles', 'restore');
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, 'package.json'), '{"name":"restore"}\n', 'utf8');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'inside-replace-rollback' },
        async (transaction) => {
          await transaction.replaceProfile(profile);
          throw new Error('trigger rollback');
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 70 });
      expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe('{"name":"restore"}\n');
    });
  });

  it('rejects out-of-home settings before reading or writing the document', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const outside = join(root, 'outside-settings.yaml');
      await writeFile(outside, 'owner: external\n', 'utf8');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'outside-settings' },
        async (transaction) =>
          transaction.writeSettings(outside, 'owner: external\n', 'owner: transaction\n'),
      );

      expectScopeFailure(result, 'E_TRANSACTION_SETTINGS_PATH_SCOPE', outside);
      expect(await readFile(outside, 'utf8')).toBe('owner: external\n');
    });
  });

  it('rejects a settings.yaml junction that escapes DSH_HOME', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const outside = join(root, 'outside-settings');
      const settings = join(dshHome, 'settings.yaml');
      await mkdir(outside, { recursive: true });
      await mkdir(dshHome, { recursive: true });
      await writeFile(join(outside, 'sentinel'), 'external\n', 'utf8');
      await symlink(outside, settings, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'junction-settings' },
        async (transaction) =>
          transaction.writeSettings(settings, undefined, 'owner: transaction\n'),
      );

      expectScopeFailure(result, 'E_TRANSACTION_SETTINGS_PATH_SCOPE', settings);
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('external\n');
    });
  });

  it('rejects a dangling settings.yaml link without replacing it', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const missingTarget = join(root, 'missing-settings-target');
      const settings = join(dshHome, 'settings.yaml');
      await mkdir(dshHome, { recursive: true });
      await symlink(missingTarget, settings, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'dangling-settings' },
        async (transaction) =>
          transaction.writeSettings(settings, undefined, 'owner: transaction\n'),
      );

      expectScopeFailure(result, 'E_TRANSACTION_SETTINGS_PATH_SCOPE', settings);
      expect((await lstat(settings)).isSymbolicLink()).toBe(true);
      expect(await nodeTransactionAdapter.pathExists(missingTarget)).toBe(false);
    });
  });

  it('rejects a .dshpack junction before creating a lock or backup outside home', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const outsideMetadata = join(root, 'outside-metadata');
      await mkdir(outsideMetadata, { recursive: true });
      await mkdir(dshHome, { recursive: true });
      await writeFile(join(outsideMetadata, 'sentinel'), 'external\n', 'utf8');
      await symlink(
        outsideMetadata,
        join(dshHome, '.dshpack'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      let operationEntered = false;
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'junction-metadata' },
        async () => {
          operationEntered = true;
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 31 });
      expect(result.diagnostics[0]).toMatchObject({
        code: 'E_TRANSACTION_METADATA_PATH_SCOPE',
        path: join(dshHome, '.dshpack'),
      });
      expect(operationEntered).toBe(false);
      expect(await readFile(join(outsideMetadata, 'sentinel'), 'utf8')).toBe('external\n');
      expect(await nodeTransactionAdapter.pathExists(join(outsideMetadata, 'artifacts.lock'))).toBe(
        false,
      );
      expect(await nodeTransactionAdapter.pathExists(join(outsideMetadata, 'backups'))).toBe(false);
    });
  });

  it('rejects a dangling .dshpack link with a precise security diagnostic', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const missingTarget = join(root, 'missing-metadata-target');
      const metadata = join(dshHome, '.dshpack');
      await mkdir(dshHome, { recursive: true });
      await symlink(missingTarget, metadata, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'dangling-metadata' },
        async () => undefined,
      );

      expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 31 });
      expect(result.diagnostics[0]).toMatchObject({
        code: 'E_TRANSACTION_METADATA_PATH_SCOPE',
        path: metadata,
      });
      expect((await lstat(metadata)).isSymbolicLink()).toBe(true);
      expect(await nodeTransactionAdapter.pathExists(missingTarget)).toBe(false);
    });
  });

  it('rejects a backups junction before an empty transaction writes its journal outside home', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const outsideBackups = join(root, 'outside-backups');
      const metadata = join(dshHome, '.dshpack');
      const backups = join(metadata, 'backups');
      await mkdir(outsideBackups, { recursive: true });
      await mkdir(metadata, { recursive: true });
      await writeFile(join(outsideBackups, 'sentinel'), 'external\n', 'utf8');
      await symlink(outsideBackups, backups, process.platform === 'win32' ? 'junction' : 'dir');
      let operationEntered = false;
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'junction-backups' },
        async () => {
          operationEntered = true;
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 31 });
      expect(result.diagnostics[0]).toMatchObject({
        code: 'E_TRANSACTION_BACKUP_PATH_SCOPE',
        path: backups,
      });
      expect(operationEntered).toBe(false);
      expect(await readFile(join(outsideBackups, 'sentinel'), 'utf8')).toBe('external\n');
      expect(
        await nodeTransactionAdapter.pathExists(join(outsideBackups, 'junction-backups')),
      ).toBe(false);
    });
  });

  it('rejects a dangling backups link before acquiring the transaction lock', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const missingTarget = join(root, 'missing-backups-target');
      const metadata = join(dshHome, '.dshpack');
      const backups = join(metadata, 'backups');
      await mkdir(metadata, { recursive: true });
      await symlink(missingTarget, backups, process.platform === 'win32' ? 'junction' : 'dir');
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'dangling-backups' },
        async () => undefined,
      );

      expect(result).toMatchObject({ ok: false, status: 'not-started', exitCode: 31 });
      expect(result.diagnostics[0]).toMatchObject({
        code: 'E_TRANSACTION_BACKUP_PATH_SCOPE',
        path: backups,
      });
      expect((await lstat(backups)).isSymbolicLink()).toBe(true);
      expect(await nodeTransactionAdapter.pathExists(missingTarget)).toBe(false);
    });
  });
});
