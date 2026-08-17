import { createHash } from 'node:crypto';
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
  expect(result.manualRecovery).toEqual([]);
}

function digest(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
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

  it('rejects malformed store and generation state paths before writing any state', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const bytes = Buffer.from('state');
      const address = digest(bytes);
      const token = address.slice('sha256-'.length);
      const outside = join(root, 'outside-state');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'sentinel'), 'external\n');
      const cases = [
        {
          kind: 'store-block' as const,
          path: join(dshHome, '.dshpack', 'store', 'zz', address),
          code: 'E_TRANSACTION_STORE_PATH_SCOPE',
        },
        {
          kind: 'store-block' as const,
          path: join(dshHome, '.dshpack', 'store', token.slice(0, 2), 'extra', address),
          code: 'E_TRANSACTION_STORE_PATH_SCOPE',
        },
        {
          kind: 'generation' as const,
          path: join(dshHome, '.dshpack', 'generations', 'web', '0001.json'),
          code: 'E_TRANSACTION_GENERATION_PATH_SCOPE',
        },
        {
          kind: 'generation' as const,
          path: join(dshHome, '.dshpack', 'generations', 'Bad', '0001.json'),
          code: 'E_TRANSACTION_GENERATION_PATH_SCOPE',
        },
      ];
      for (const [index, entry] of cases.entries()) {
        const result = await runTransaction(
          { adapter: nodeTransactionAdapter, dshHome, txid: `malformed-state-${String(index)}` },
          async (transaction) => transaction.writeStateFile(entry.kind, entry.path, bytes),
        );
        expectScopeFailure(result, entry.code, entry.path);
      }
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('external\n');
    });
  });

  it('rejects noncanonical managed-marker and generation filename leaves before any state action', async () => {
    await withTemporaryRoot(async (_root, dshHome) => {
      const managed = ['Bad.json', '.json', 'web.json'];
      for (const [index, leaf] of managed.entries()) {
        const path = join(dshHome, '.dshpack', 'installed', leaf);
        const result = await runTransaction(
          {
            adapter: nodeTransactionAdapter,
            dshHome,
            txid: `invalid-managed-leaf-${String(index)}`,
          },
          async (transaction) => transaction.writeManagedDocument(path, '{"metadataVersion":1}\n'),
        );
        expectScopeFailure(result, 'E_TRANSACTION_MANAGED_DOCUMENT_PATH_SCOPE', path);
        await expect(lstat(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' });
      }

      const generation = [
        'not-a-sequence.json',
        '0000.json',
        '00001.json',
        `${String(Number.MAX_SAFE_INTEGER + 1)}.json`,
      ];
      for (const [index, leaf] of generation.entries()) {
        const path = join(dshHome, '.dshpack', 'generations', 'demo-pack', leaf);
        const result = await runTransaction(
          {
            adapter: nodeTransactionAdapter,
            dshHome,
            txid: `invalid-generation-leaf-${String(index)}`,
          },
          async (transaction) =>
            transaction.writeStateFile('generation', path, Buffer.from('{}\n')),
        );
        expectScopeFailure(result, 'E_TRANSACTION_GENERATION_PATH_SCOPE', path);
        await expect(lstat(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });
  });

  it('accepts the canonical positive safe-integer generation filename boundary', async () => {
    await withTemporaryRoot(async (_root, dshHome) => {
      const leaf = `${String(Number.MAX_SAFE_INTEGER)}.json`;
      const path = join(dshHome, '.dshpack', 'generations', 'demo-pack', leaf);
      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'maximum-safe-generation-leaf' },
        async (transaction) => transaction.writeStateFile('generation', path, Buffer.from('{}\n')),
      );

      expect(result).toMatchObject({ exitCode: 0, status: 'committed', manualRecovery: [] });
      expect(await readFile(path, 'utf8')).toBe('{}\n');
    });
  });

  it('rejects store and generation parent junctions without touching the external sentinel', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const bytes = Buffer.from('state');
      const address = digest(bytes);
      const token = address.slice('sha256-'.length);
      const outside = join(root, 'outside-state-root');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'sentinel'), 'external\n');
      await mkdir(join(dshHome, '.dshpack'), { recursive: true });
      await symlink(
        outside,
        join(dshHome, '.dshpack', 'store'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const storePath = join(dshHome, '.dshpack', 'store', token.slice(0, 2), address);
      const storeResult = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'store-parent-junction' },
        async (transaction) => transaction.writeStateFile('store-block', storePath, bytes),
      );
      expectScopeFailure(storeResult, 'E_TRANSACTION_STORE_PATH_SCOPE', storePath);

      await rm(join(dshHome, '.dshpack', 'store'), { recursive: true, force: true });
      await symlink(
        outside,
        join(dshHome, '.dshpack', 'generations'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const current = join(dshHome, '.dshpack', 'generations', 'demo-pack', 'current');
      const generationResult = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'generation-parent-junction' },
        async (transaction) => transaction.writeGenerationCurrent(current, undefined, '1\n'),
      );
      expectScopeFailure(generationResult, 'E_TRANSACTION_GENERATION_PATH_SCOPE', current);
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('external\n');
    });
  });

  it('revalidates a store parent swapped after the first validation before binary write', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const bytes = Buffer.from('state');
      const address = digest(bytes);
      const token = address.slice('sha256-'.length);
      const store = join(dshHome, '.dshpack', 'store');
      const path = join(store, token.slice(0, 2), address);
      const outside = join(root, 'outside-swapped-store');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'sentinel'), 'external\n');
      const base = nodeTransactionAdapter;
      let validations = 0;
      const result = await runTransaction(
        {
          adapter: {
            ...base,
            validateMutationPath: async (lock, kind, candidate) => {
              await base.validateMutationPath(lock, kind, candidate);
              if (kind === 'store-block' && ++validations === 1) {
                await symlink(outside, store, process.platform === 'win32' ? 'junction' : 'dir');
              }
            },
          },
          dshHome,
          txid: 'store-parent-swapped',
        },
        async (transaction) => transaction.writeStateFile('store-block', path, bytes),
      );
      expectScopeFailure(result, 'E_TRANSACTION_STORE_DIRECTORY_SCOPE', store);
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('external\n');
      await expect(readFile(join(outside, token.slice(0, 2), address))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('revalidates a store parent swapped after parent creation immediately before the binary write', async () => {
    await withTemporaryRoot(async (root, dshHome) => {
      const bytes = Buffer.from('state');
      const address = digest(bytes);
      const token = address.slice('sha256-'.length);
      const store = join(dshHome, '.dshpack', 'store');
      const prefix = join(store, token.slice(0, 2));
      const path = join(prefix, address);
      const outside = join(root, 'outside-final-store-guard');
      await mkdir(outside, { recursive: true });
      await mkdir(prefix, { recursive: true });
      await writeFile(join(outside, 'sentinel'), 'external\n');
      const base = nodeTransactionAdapter;
      let storeBlockValidations = 0;
      const result = await runTransaction(
        {
          adapter: {
            ...base,
            async validateMutationPath(lock, kind, candidate) {
              if (kind === 'store-block' && ++storeBlockValidations === 2) {
                await rm(store, { recursive: true, force: true });
                await symlink(outside, store, process.platform === 'win32' ? 'junction' : 'dir');
              }
              await base.validateMutationPath(lock, kind, candidate);
            },
          },
          dshHome,
          txid: 'store-parent-swapped-after-create',
        },
        async (transaction) => transaction.writeStateFile('store-block', path, bytes),
      );
      expect(result).toMatchObject({
        ok: false,
        status: 'rolled-back',
        exitCode: 31,
        manualRecovery: [],
        diagnostics: [{ code: 'E_TRANSACTION_STORE_PATH_SCOPE', path }],
      });
      expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('external\n');
      await expect(readFile(join(outside, address))).rejects.toMatchObject({ code: 'ENOENT' });
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
