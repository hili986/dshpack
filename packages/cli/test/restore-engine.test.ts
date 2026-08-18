import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import { diagnostic } from '../src/commands/shared.js';
import { EXIT_CODES } from '../src/exit-codes.js';
import { installPack } from '../src/install/engine.js';
import { ManagementStateError } from '../src/management/state.js';
import type { MetadataAsset, ObservedAsset } from '../src/metadata/contracts.js';
import { type GenerationDocument, settingsContribution } from '../src/metadata/state-storage.js';
import {
  appendRestoredSettings,
  exitCodeForManagementState,
  materializeAsset,
  observeAsset,
  readMarker,
  restoreDrift,
  restoredMetadata,
  restoreProfile,
  targetAssets,
  warnings,
} from '../src/restore/engine.js';
import {
  createNodeTransactionAdapter,
  type TransactionAdapter,
  type TransactionContext,
} from '../src/transaction.js';
import { MAX_TRANSACTION_STATE_BYTES } from '../src/transaction-types.js';
import { uninstallProfile } from '../src/uninstall/engine.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

vi.mock('../src/doctor/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doctor/engine.js')>();
  return {
    ...actual,
    runDoctor: async () => ({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { sideEffects: [] },
    }),
  };
});

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-restore-'));
  roots.push(root);
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function capturedEntries(
  dshHome: string,
  entries: readonly { target: string }[],
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of entries)
    result.set(entry.target, await readFile(join(dshHome, ...entry.target.split('/'))));
  return result;
}

async function logicalSnapshot(root: string, relative = ''): Promise<Record<string, string>> {
  const entries = await readdir(join(root, relative));
  const snapshot: Record<string, string> = {};
  for (const name of entries.sort((left, right) => left.localeCompare(right, 'en'))) {
    const childRelative = relative === '' ? name : `${relative}/${name}`;
    if (childRelative.startsWith('.dshpack/backups/')) continue;
    const child = join(root, childRelative);
    if ((await stat(child)).isDirectory())
      Object.assign(snapshot, await logicalSnapshot(root, childRelative));
    else snapshot[childRelative] = (await readFile(child)).toString('base64');
  }
  return snapshot;
}

function generationPath(dshHome: string, sequence: number): string {
  return join(
    dshHome,
    '.dshpack',
    'generations',
    'engine-pack',
    `${String(sequence).padStart(4, '0')}.json`,
  );
}

async function advanceCurrentGenerationForSettings(
  dshHome: string,
  marker: Record<string, unknown>,
): Promise<void> {
  const initial = JSON.parse(await readFile(generationPath(dshHome, 1), 'utf8')) as Record<
    string,
    unknown
  >;
  marker.generation = 2;
  await writeFile(
    generationPath(dshHome, 2),
    `${JSON.stringify({
      ...initial,
      seq: 2,
      txid: 'update-settings',
      operation: 'update',
      metadata: marker,
      settingsContribution: marker.settingsContribution,
    })}\n`,
  );
  await writeFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current'), '2\n');
  await writeFile(
    join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    `${JSON.stringify(marker)}\n`,
  );
}

async function synchronizeCurrentGenerationMarker(
  dshHome: string,
  marker: Record<string, unknown>,
): Promise<void> {
  const currentPath = join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current');
  const current = Number((await readFile(currentPath, 'utf8')).trim());
  const path = generationPath(dshHome, current);
  const generation = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  marker.generation = current;
  generation.metadata = marker;
  generation.settingsContribution = marker.settingsContribution;
  await writeFile(path, `${JSON.stringify(generation)}\n`);
  await writeFile(
    join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
    `${JSON.stringify(marker)}\n`,
  );
}

async function installedThenUninstalled(dshHome: string): Promise<void> {
  await expect(
    installPack(
      { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
      fakeRuntime().runtime,
    ),
  ).resolves.toMatchObject({ exitCode: 0 });
  await expect(
    uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
  ).resolves.toMatchObject({ exitCode: 0 });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('restore engine', () => {
  it('plans every settings restoration shape without rewriting user-owned YAML', () => {
    const values = [{ key: 'custom', value: { model: 'restored' } }];
    expect(appendRestoredSettings(undefined, values)).toMatchObject({
      expected: undefined,
      replacement: expect.stringContaining('agent-presets:\n  custom:'),
      retained: [],
    });
    expect(appendRestoredSettings('anything: kept\n', [])).toEqual({
      expected: 'anything: kept\n',
      replacement: undefined,
      retained: [],
    });
    expect(() => appendRestoredSettings('agent-presets: [broken\n', values)).toThrow(
      /settings.yaml is not valid YAML/u,
    );
    expect(appendRestoredSettings('agent-presets:\n  custom: user\n', values)).toEqual({
      expected: 'agent-presets:\n  custom: user\n',
      replacement: undefined,
      retained: ['custom'],
    });
    expect(appendRestoredSettings('agent-presets:\n  existing: user\n', values)).toMatchObject({
      replacement: expect.stringContaining('  custom:'),
      retained: [],
    });
    expect(appendRestoredSettings('agent-presets: {}\n', values)).toMatchObject({
      replacement: expect.stringContaining('agent-presets:\n  custom:'),
      retained: [],
    });
    expect(appendRestoredSettings('agent-presets: {} # user comment\n', values)).toEqual({
      expected: 'agent-presets: {} # user comment\n',
      replacement: undefined,
      retained: ['custom'],
    });
    expect(appendRestoredSettings('agent-presets: {existing: user}\n', values)).toEqual({
      expected: 'agent-presets: {existing: user}\n',
      replacement: undefined,
      retained: ['custom'],
    });
    expect(appendRestoredSettings('agent-presets:\n', values)).toMatchObject({
      replacement: expect.stringContaining('agent-presets:\n  custom:'),
    });
    expect(appendRestoredSettings('agent-presets: scalar\n', values)).toEqual({
      expected: 'agent-presets: scalar\n',
      replacement: undefined,
      retained: ['custom'],
    });
    expect(appendRestoredSettings('outside: kept', values)).toMatchObject({
      replacement: expect.stringContaining('outside: kept\nagent-presets:\n  custom:'),
    });
    expect(appendRestoredSettings('plain scalar', values)).toMatchObject({
      replacement: expect.stringContaining('plain scalar\nagent-presets:\n  custom:'),
    });
    expect(appendRestoredSettings('', values)).toMatchObject({
      replacement: expect.stringContaining('agent-presets:\n  custom:'),
    });
  });

  it('retains non-map namespaces and materializes a comment-free empty flow map without a final EOL', () => {
    const values = [{ key: 'custom', value: { model: 'restored' } }];

    expect(appendRestoredSettings('agent-presets: null\n', values)).toMatchObject({
      replacement: expect.stringContaining('  custom:'),
      retained: [],
    });
    expect(appendRestoredSettings('agent-presets: []\n', values)).toEqual({
      expected: 'agent-presets: []\n',
      replacement: undefined,
      retained: ['custom'],
    });
    expect(appendRestoredSettings('agent-presets: {}', values)).toEqual({
      expected: 'agent-presets: {}',
      replacement: 'agent-presets:\n  custom:\n    model: restored\n',
      retained: [],
    });
  });

  it('preserves EOL and trailing bytes across every non-destructive settings insertion shape', () => {
    const values = [{ key: 'custom', value: { model: 'restored' } }];
    const cases = [
      'agent-presets:\n  existing: user',
      'agent-presets: null',
      'agent-presets: {}\nnext: retained\n',
      'agent-presets: {}\r\n',
    ];

    for (const source of cases) {
      const plan = appendRestoredSettings(source, values);
      expect(plan.expected).toBe(source);
      expect(plan.replacement).toContain('  custom:');
      expect(plan.retained).toEqual([]);
    }
  });

  it('inserts restored keys inside agent-presets before later root namespaces', () => {
    const source = [
      'agent-presets:',
      '  existing: keep',
      'other-namespace:',
      '  untouched: true',
      '',
    ].join('\n');

    const plan = appendRestoredSettings(source, [{ key: 'custom', value: { model: 'restored' } }]);

    expect(plan.replacement).toBeDefined();
    const parsed = parseDocument(plan.replacement ?? '').toJS() as Record<string, unknown>;
    expect(parsed['agent-presets']).toEqual({
      existing: 'keep',
      custom: { model: 'restored' },
    });
    expect(parsed['other-namespace']).toEqual({ untouched: true });
    expect(plan.replacement).toContain(
      '  existing: keep\n  custom:\n    model: restored\nother-namespace:',
    );
  });

  it('populates a null agent-presets header before later root namespaces', () => {
    const source = ['agent-presets:', 'other-namespace:', '  untouched: true', ''].join('\n');

    const plan = appendRestoredSettings(source, [{ key: 'custom', value: { model: 'restored' } }]);

    expect(plan.replacement).toBeDefined();
    const parsed = parseDocument(plan.replacement ?? '').toJS() as Record<string, unknown>;
    expect(parsed['agent-presets']).toEqual({ custom: { model: 'restored' } });
    expect(parsed['other-namespace']).toEqual({ untouched: true });
    expect(plan.replacement).toContain(
      'agent-presets:\n  custom:\n    model: restored\nother-namespace:',
    );
  });

  it('classifies restore drift from bytes, file counts, and absent assets', () => {
    const asset: MetadataAsset = {
      id: 'notes',
      kind: 'skill',
      target: 'skills/notes',
      action: 'create',
      identity: '1:2:3',
      files: [{ path: 'SKILL.md', sha256: 'sha256-expected', bytes: 4 }],
    };
    const intact: ObservedAsset = {
      identity: 'different-identity',
      files: [{ path: 'SKILL.md', sha256: 'sha256-expected', bytes: 4 }],
    };
    expect(restoreDrift(asset, undefined)).toBe('missing');
    expect(restoreDrift(asset, { ...intact, files: [] })).toBe('modified');
    expect(
      restoreDrift(asset, {
        ...intact,
        files: [{ path: 'SKILL.md', sha256: 'sha256-expected', bytes: 5 }],
      }),
    ).toBe('modified');
    expect(restoreDrift(asset, intact)).toBe('intact');
  });

  it('rejects a non-directory managed asset path during direct restore observation', async () => {
    const dshHome = await home();
    await mkdir(join(dshHome, 'skills'), { recursive: true });
    await writeFile(join(dshHome, 'skills', 'notes'), 'user file\n');
    const asset: MetadataAsset = {
      id: 'notes',
      kind: 'skill',
      target: 'skills/notes',
      action: 'create',
      identity: '1:2:3',
      files: [],
    };

    await expect(observeAsset(dshHome, asset)).rejects.toMatchObject({
      exitCode: 31,
      code: 'E_RESTORE_ASSET_PATH',
    });
  });

  it('rejects malformed target inventories and missing preflight bytes before writing', async () => {
    const asset: MetadataAsset = {
      id: 'notes',
      kind: 'skill',
      target: 'skills/notes',
      action: 'create',
      identity: '1:2:3',
      files: [{ path: 'SKILL.md', sha256: 'sha256-bytes', bytes: 5 }],
    };
    const installed = {
      seq: 1,
      txid: 'restore-test',
      createdAt: '2026-08-18T00:00:00.000Z',
      operation: 'install',
      pack: { name: 'engine-pack', version: '1.0.0', manifestDigest: 'sha256-manifest' },
      source: { kind: 'directory', path: 'C:/safe/source' },
      entries: [{ target: 'skills/notes/SKILL.md', sha256: 'sha256-bytes' }],
      settingsContribution: { namespace: 'agent-presets', keys: [] },
      metadata: { assets: [asset] },
      restorable: true,
    } as unknown as GenerationDocument;
    expect(targetAssets(installed)).toEqual([asset]);
    expect(targetAssets({ ...installed, metadata: null, entries: [] })).toEqual([]);
    expect(() => targetAssets({ ...installed, metadata: null })).toThrow(/uninstalled generation/u);
    expect(() =>
      targetAssets({ ...installed, entries: [{ target: 'unowned/file', sha256: 'sha256-bytes' }] }),
    ).toThrow(/not attributable/u);
    expect(
      targetAssets({
        ...installed,
        entries: [],
        metadata: { assets: [{ ...asset, action: 'skip' }] },
      } as unknown as GenerationDocument),
    ).toEqual([]);

    const transaction = {
      create: async (_kind: string, _path: string, operation: () => Promise<void>) => operation(),
    } as unknown as TransactionContext;
    await expect(
      materializeAsset(
        transaction,
        'C:/safe/home',
        asset,
        { ...installed, entries: [] },
        new Map(),
      ),
    ).rejects.toThrow(/no immutable generation entries/u);
    await expect(
      materializeAsset(transaction, 'C:/safe/home', asset, installed, new Map()),
    ).rejects.toThrow(/CAS preflight lost/u);
  });

  it('maps every typed management-state failure to its restore exit class', () => {
    const issue = (kind: ConstructorParameters<typeof ManagementStateError>[0]) =>
      new ManagementStateError(kind, diagnostic('E_TEST', 'error', 'test', 'repair'));
    expect(exitCodeForManagementState(issue('security'))).toBe(EXIT_CODES.SECURITY);
    expect(exitCodeForManagementState(issue('changed'))).toBe(EXIT_CODES.SECURITY);
    expect(exitCodeForManagementState(issue('environment'))).toBe(EXIT_CODES.INTERNAL);
    expect(exitCodeForManagementState(issue('contract'))).toBe(EXIT_CODES.CONTRACT);
    expect(exitCodeForManagementState(issue('missing'))).toBe(EXIT_CODES.CONTRACT);
  });

  it('reads marker and asset paths fail-closed without a transaction', async () => {
    const dshHome = await home();
    await expect(readMarker(dshHome, 'engine-pack')).resolves.toEqual(
      expect.objectContaining({ home: expect.any(Object) }),
    );
    await expect(readMarker(join(dshHome, 'missing-home'), 'engine-pack')).rejects.toThrow(
      /managed home cannot be read securely/u,
    );
    await mkdir(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), { recursive: true });
    await expect(readMarker(dshHome, 'engine-pack')).rejects.toThrow();

    const asset: MetadataAsset = {
      id: 'notes',
      kind: 'skill',
      target: 'skills/notes',
      action: 'create',
      identity: '1:2:3',
      files: [{ path: 'SKILL.md', sha256: 'sha256-test', bytes: 4 }],
    };
    expect(await observeAsset(dshHome, asset)).toBeUndefined();
    const target = join(dshHome, 'skills', 'notes');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), 'test');
    await expect(observeAsset(dshHome, asset)).resolves.toMatchObject({ files: expect.any(Array) });
    await rm(target, { recursive: true, force: true });
    await writeFile(target, 'a regular file cannot become a managed directory');
    await expect(observeAsset(dshHome, asset)).rejects.toThrow(/regular directory/u);
  });

  it('preserves only materialized restored metadata and renders review warnings', async () => {
    const materialized: MetadataAsset = {
      id: 'profile',
      kind: 'profile',
      target: 'profiles/engine-pack',
      action: 'create',
      identity: 'historical',
      files: [],
    };
    const retained: MetadataAsset = {
      id: 'notes',
      kind: 'skill',
      target: 'skills/notes',
      action: 'create',
      identity: 'historical',
      files: [],
    };
    const skipped: MetadataAsset = {
      id: 'preset',
      kind: 'preset',
      target: '.agent-presets/custom',
      action: 'skip',
      identity: 'historical',
      files: [],
    };
    const plan = {
      target: {
        metadata: {
          profile: 'engine-pack',
          assets: [materialized, retained, skipped],
          settingsContribution: { namespace: 'agent-presets', keys: [] },
        },
      },
      assets: [
        { target: materialized.target, action: 'materialize', reason: 'target-generation' },
        { target: retained.target, action: 'retain', reason: 'modified' },
        { target: skipped.target, action: 'unchanged', reason: 'untracked' },
      ],
      settings: { retained: ['custom\u001b[2J\u202E'] },
    } as never;
    const metadata = await restoredMetadata(
      plan,
      { artifactIdentity: async () => 'fresh-identity' } as unknown as TransactionContext,
      'C:/safe/home',
      9,
    );
    expect(metadata).toMatchObject({ generation: 9 });
    expect(metadata?.assets).toEqual([
      expect.objectContaining({
        target: materialized.target,
        action: 'create',
        identity: 'fresh-identity',
      }),
      expect.objectContaining({ target: retained.target, action: 'skip' }),
      expect.objectContaining({ target: skipped.target, action: 'skip' }),
    ]);
    expect(warnings(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'W_RESTORE_ASSET_RETAINED' }),
        expect.objectContaining({ code: 'W_RESTORE_SETTINGS_RETAINED' }),
      ]),
    );
    const renderedWarnings = warnings(plan)
      .map((item) => item.message)
      .join('\n');
    expect(renderedWarnings).not.toContain('\u001b');
    expect(renderedWarnings).not.toContain('\u202e');
    expect(renderedWarnings).toContain('custom\\u001b[2J\\u202e');
  });

  it('lists retained generations read-only with their required audit fields', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', list: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        generations: [
          expect.objectContaining({
            seq: 1,
            createdAt: expect.any(String),
            operation: 'install',
            packVersion: '1.0.0',
            restorable: true,
          }),
        ],
      },
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('restores safely in a real temporary DSH_HOME segment named DS64B1~1', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'dshpack-restore-short-'));
    roots.push(outer);
    const dshHome = join(outer, 'DS64B1~1');
    await mkdir(dshHome);
    await installedThenUninstalled(dshHome);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe(
      '---\nname: notes\ndescription: fixture notes\n---\n# Notes\n',
    );
  });

  it('maps an oversized managed generation read to an internal environment report without writes', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const path = generationPath(dshHome, 1);
    await writeFile(path, Buffer.alloc(MAX_TRANSACTION_STATE_BYTES + 1, 1));
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', list: true });

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.INTERNAL,
      diagnostics: [expect.objectContaining({ code: 'E_MANAGEMENT_GENERATION', path })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('fails closed on every malformed peer installed-marker entry before restore can write', async () => {
    const cases: ReadonlyArray<{
      name: string;
      create: (installed: string) => Promise<void>;
      exitCode: number;
    }> = [
      {
        name: 'a non-regular entry',
        create: async (installed) => mkdir(join(installed, 'peer.json')),
        exitCode: EXIT_CODES.SECURITY,
      },
      {
        name: 'a non-marker file',
        create: async (installed) => writeFile(join(installed, 'README'), 'not a marker\n'),
        exitCode: EXIT_CODES.CONTRACT,
      },
      {
        name: 'an unsafe profile filename',
        create: async (installed) => writeFile(join(installed, 'bad profile.json'), '{}\n'),
        exitCode: EXIT_CODES.CONTRACT,
      },
      {
        name: 'invalid peer JSON',
        create: async (installed) => writeFile(join(installed, 'peer.json'), '{not-json\n'),
        exitCode: EXIT_CODES.CONTRACT,
      },
      {
        name: 'a peer marker outside the versioned contract',
        create: async (installed) => writeFile(join(installed, 'peer.json'), '{}\n'),
        exitCode: EXIT_CODES.CONTRACT,
      },
    ];

    for (const peerCase of cases) {
      const dshHome = await home();
      await expect(
        installPack(
          { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      await peerCase.create(join(dshHome, '.dshpack', 'installed'));
      const before = await logicalSnapshot(dshHome);

      const report = await restoreProfile({ dshHome, profile: 'engine-pack', to: 1, yes: true });

      expect(report, peerCase.name).toMatchObject({
        exitCode: peerCase.exitCode,
        diagnostics: [expect.objectContaining({ code: 'E_RESTORE_METADATA' })],
      });
      expect(await logicalSnapshot(dshHome), peerCase.name).toEqual(before);
    }
  });

  it('keeps settings untouched when an effective generation owns no settings keys', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as Record<string, unknown>;
    marker.generation = 2;
    marker.settingsContribution = { namespace: 'agent-presets', keys: [] };
    const installed = JSON.parse(await readFile(generationPath(dshHome, 1), 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      generationPath(dshHome, 2),
      `${JSON.stringify({
        ...installed,
        seq: 2,
        txid: 'update-without-settings',
        operation: 'update',
        metadata: marker,
        settingsContribution: marker.settingsContribution,
      })}\n`,
    );
    await writeFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current'), '2\n');
    await writeFile(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
      `${JSON.stringify(marker)}\n`,
    );
    const settingsPath = join(dshHome, 'settings.yaml');
    const before = await readFile(settingsPath, 'utf8');

    const report = await restoreProfile({
      dshHome,
      profile: 'engine-pack',
      to: 2,
      dryRun: true,
    });

    expect(report).toMatchObject({ exitCode: 0, metadata: { targetGeneration: 2, dryRun: true } });
    expect(await readFile(settingsPath, 'utf8')).toBe(before);
  });

  it('makes dry-run and a missing --yes write-free, even when --force is present', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);

    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', dryRun: true }),
    ).resolves.toMatchObject({ exitCode: 0, metadata: { dryRun: true, targetGeneration: 1 } });
    const declined = await restoreProfile({
      dshHome,
      profile: 'engine-pack',
      force: true,
    });

    expect(declined).toMatchObject({
      exitCode: 21,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_CONFIRM_REQUIRED' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('restores an arbitrary installed generation and then an uninstall generation byte-for-byte', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const installed = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json'), 'utf8'),
    ) as {
      entries: Array<{ target: string; sha256: string }>;
      metadata: unknown;
    };
    const expected = await capturedEntries(dshHome, installed.entries);
    const installedSettings = await readFile(join(dshHome, 'settings.yaml'), 'utf8');
    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 0,
    });
    const uninstalledSettings = await readFile(join(dshHome, 'settings.yaml'), 'utf8');
    expect(await readdir(join(dshHome, '.dshpack', 'generations', 'engine-pack'))).toEqual([
      '0001.json',
      '0002.json',
      'current',
    ]);

    const restored = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(restored.diagnostics).toEqual([]);
    expect(restored).toMatchObject({ exitCode: 0, metadata: { targetGeneration: 1 } });
    const restoredMetadata = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as { generation: number; assets: Array<{ target: string; identity: string }> };
    expect(restoredMetadata).toMatchObject({ generation: 3 });
    expect(restoredMetadata.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'profiles/engine-pack', identity: expect.any(String) }),
        expect.objectContaining({ target: 'skills/notes', identity: expect.any(String) }),
      ]),
    );
    for (const [target, bytes] of expected)
      expect(await readFile(join(dshHome, ...target.split('/')))).toEqual(bytes);
    expect(await readFile(join(dshHome, 'settings.yaml'), 'utf8')).toBe(installedSettings);
    expect(
      JSON.parse(
        await readFile(
          join(dshHome, '.dshpack', 'generations', 'engine-pack', '0003.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      operation: 'restore',
      entries: installed.entries,
      metadata: restoredMetadata,
    });

    const uninstalled = await restoreProfile({ dshHome, profile: 'engine-pack', to: 2, yes: true });

    expect(uninstalled).toMatchObject({ exitCode: 0, metadata: { targetGeneration: 2 } });
    expect(await exists(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'))).toBe(false);
    const remaining = await Promise.all(
      [...expected.keys()].map(async (target) => ({
        target,
        exists: await exists(join(dshHome, ...target.split('/'))),
      })),
    );
    expect(remaining).toEqual(remaining.map((item) => ({ ...item, exists: false })));
    expect(await readFile(join(dshHome, 'settings.yaml'), 'utf8')).toBe(uninstalledSettings);
    expect(
      JSON.parse(
        await readFile(
          join(dshHome, '.dshpack', 'generations', 'engine-pack', '0004.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ operation: 'restore', entries: [], metadata: null });
  });

  it('reverses an intact current settings contribution before merging an installed target', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as Record<string, unknown>;
    marker.settingsContribution = settingsContribution({
      custom: { model: 'updated' },
      currentOnly: { model: 'remove-me' },
    });
    await advanceCurrentGenerationForSettings(dshHome, marker);
    const settingsPath = join(dshHome, 'settings.yaml');
    await writeFile(
      settingsPath,
      'agent-presets:\n  custom:\n    model: updated\n  currentOnly:\n    model: remove-me\n',
    );

    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', to: 1, yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(await readFile(settingsPath, 'utf8')).toBe(
      'agent-presets:\n  custom:\n    model: fixture\n',
    );
  });

  it('retains a settings key changed by the user while restoring an older generation', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as Record<string, unknown>;
    marker.settingsContribution = settingsContribution({ custom: { model: 'updated' } });
    await advanceCurrentGenerationForSettings(dshHome, marker);
    const settingsPath = join(dshHome, 'settings.yaml');
    const userValue = 'agent-presets:\n  custom:\n    model: user-modified\n';
    await writeFile(settingsPath, userValue);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', to: 1, yes: true });

    expect(report).toMatchObject({ exitCode: 0, metadata: { retainedSettings: ['custom'] } });
    expect(await readFile(settingsPath, 'utf8')).toBe(userValue);
  });

  it('applies only the inverse settings merge when an installed target contributed no settings', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const empty = settingsContribution({});
    const targetPath = generationPath(dshHome, 1);
    const target = JSON.parse(await readFile(targetPath, 'utf8')) as {
      metadata: Record<string, unknown>;
      settingsContribution: unknown;
    };
    target.settingsContribution = empty;
    target.metadata.settingsContribution = empty;
    await writeFile(targetPath, `${JSON.stringify(target)}\n`);
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as Record<string, unknown>;
    marker.settingsContribution = settingsContribution({ currentOnly: { model: 'remove-me' } });
    await advanceCurrentGenerationForSettings(dshHome, marker);
    const settingsPath = join(dshHome, 'settings.yaml');
    await writeFile(settingsPath, 'agent-presets:\n  currentOnly:\n    model: remove-me\n');

    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', to: 1, yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(parseDocument(await readFile(settingsPath, 'utf8')).toJS()).toEqual({
      'agent-presets': {},
    });
  });

  it('retains a user-modified current setting when an installed target contributed no settings', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const empty = settingsContribution({});
    const targetPath = generationPath(dshHome, 1);
    const target = JSON.parse(await readFile(targetPath, 'utf8')) as {
      metadata: Record<string, unknown>;
      settingsContribution: unknown;
    };
    target.settingsContribution = empty;
    target.metadata.settingsContribution = empty;
    await writeFile(targetPath, `${JSON.stringify(target)}\n`);
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as Record<string, unknown>;
    marker.settingsContribution = settingsContribution({ custom: { model: 'pack-value' } });
    await advanceCurrentGenerationForSettings(dshHome, marker);
    const settingsPath = join(dshHome, 'settings.yaml');
    const userValue = 'agent-presets:\n  custom:\n    model: user-modified\n';
    await writeFile(settingsPath, userValue);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', to: 1, yes: true });

    expect(report).toMatchObject({ exitCode: 0, metadata: { retainedSettings: ['custom'] } });
    expect(await readFile(settingsPath, 'utf8')).toBe(userValue);
  });

  it('records restored directory identities so a later uninstall recognizes intact content', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 0,
    });

    const uninstalled = await uninstallProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(uninstalled).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({ target: 'skills/notes', action: 'delete', reason: 'intact' }),
        ]),
      },
    });
  });

  it('retains a user-modified asset by default and removes it only with explicit force', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const skill = join(dshHome, 'skills', 'notes', 'SKILL.md');
    await writeFile(skill, 'user-owned work after restore\n');

    const retained = await restoreProfile({ dshHome, profile: 'engine-pack', to: 2, yes: true });

    expect(retained).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({ target: 'skills/notes', action: 'retain', reason: 'modified' }),
        ]),
      },
    });
    expect(await readFile(skill, 'utf8')).toBe('user-owned work after restore\n');

    const forceHome = await home();
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true }),
          dshHome: forceHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      uninstallProfile({ dshHome: forceHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      restoreProfile({ dshHome: forceHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await writeFile(join(forceHome, 'skills', 'notes', 'SKILL.md'), 'user-owned force case\n');

    const forced = await restoreProfile({
      dshHome: forceHome,
      profile: 'engine-pack',
      to: 2,
      force: true,
      yes: true,
    });

    expect(forced).toMatchObject({ exitCode: 0 });
    expect(await exists(join(forceHome, 'skills', 'notes'))).toBe(false);
  });

  it('preserves a user-deleted managed asset unless restore is explicitly forced', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const skill = join(dshHome, 'skills', 'notes');
    await rm(skill, { recursive: true, force: true });

    const retained = await restoreProfile({ dshHome, profile: 'engine-pack', to: 1, yes: true });

    expect(retained).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({ target: 'skills/notes', action: 'retain', reason: 'missing' }),
        ]),
      },
    });
    expect(await exists(skill)).toBe(false);

    const forced = await restoreProfile({
      dshHome,
      profile: 'engine-pack',
      to: 1,
      force: true,
      yes: true,
    });

    expect(forced).toMatchObject({ exitCode: 0 });
    expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toBe(
      '---\nname: notes\ndescription: fixture notes\n---\n# Notes\n',
    );
  });

  it('retains a user-created target that was absent from the current uninstalled marker unless forced', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const skill = join(dshHome, 'skills', 'notes');
    const document = join(skill, 'SKILL.md');
    await mkdir(skill, { recursive: true });
    await writeFile(document, 'user-created restore collision\n');

    const retained = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(retained).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            action: 'retain',
            reason: 'untracked',
          }),
        ]),
      },
    });
    expect(await readFile(document, 'utf8')).toBe('user-created restore collision\n');
    const retainedMarker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as { assets: Array<{ target: string; action: string }> };
    expect(retainedMarker.assets).toContainEqual(
      expect.objectContaining({ target: 'skills/notes', action: 'skip' }),
    );

    const forced = await restoreProfile({
      dshHome,
      profile: 'engine-pack',
      to: 1,
      force: true,
      yes: true,
    });

    expect(forced).toMatchObject({ exitCode: 0 });
    expect(await readFile(document, 'utf8')).toBe(
      '---\nname: notes\ndescription: fixture notes\n---\n# Notes\n',
    );
  });

  it('keeps unsupported historical assets inert and handles an uninstalled target marker', async () => {
    const unsupported: MetadataAsset = {
      id: 'marker',
      kind: 'managed-document',
      target: '.dshpack/installed/engine-pack.json',
      action: 'create',
      identity: 'historical',
      files: [],
    };
    const tx = {
      create: vi.fn(),
      artifactIdentity: vi.fn(async () => 'fresh-identity'),
    } as unknown as TransactionContext;
    const target = { entries: [], metadata: { profile: 'engine-pack', assets: [unsupported] } };

    await expect(
      materializeAsset(
        tx,
        'C:/safe/home',
        unsupported,
        target as unknown as GenerationDocument,
        new Map(),
      ),
    ).resolves.toBeUndefined();
    expect(tx.create).not.toHaveBeenCalled();
    await expect(
      restoredMetadata(
        { target: { metadata: null }, assets: [], settings: undefined } as never,
        tx,
        'C:/safe/home',
        10,
      ),
    ).resolves.toBeNull();
    expect(warnings({ assets: [], settings: undefined } as never)).toEqual([]);
  });

  it('writes a restorable generation after retaining an untracked asset', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const document = join(dshHome, 'skills', 'notes', 'SKILL.md');
    await mkdir(join(document, '..'), { recursive: true });
    await writeFile(document, 'user-created state that restore must retain\n');

    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0, metadata: { generation: 3 } });
    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', to: 2, yes: true }),
    ).resolves.toMatchObject({ exitCode: 0, metadata: { generation: 4 } });

    const replay = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(replay).toMatchObject({ exitCode: 0, metadata: { generation: 5 } });
    expect(await readFile(document, 'utf8')).toBe('user-created state that restore must retain\n');
  });

  it('fails before mutation when a target generation references a missing CAS block', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const generation = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'generations', 'engine-pack', '0001.json'), 'utf8'),
    ) as { entries: Array<{ sha256: string }> };
    const missing = [...new Set(generation.entries.map((entry) => entry.sha256))];
    expect(missing.length).toBeGreaterThan(1);
    await Promise.all(
      missing.map((digest) =>
        rm(join(dshHome, '.dshpack', 'store', digest.slice(7, 9), digest), { force: true }),
      ),
    );
    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 30,
      metadata: { missingCasBlocks: expect.arrayContaining(missing) },
    });
    expect(report.metadata.missingCasBlocks).toHaveLength(missing.length);
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('rolls back the full logical state if restore fails after it starts moving assets', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const before = await logicalSnapshot(dshHome);
    const base = createNodeTransactionAdapter();
    const adapter: TransactionAdapter = {
      ...base,
      async compareAndSwapManagedDocument() {
        return false;
      },
    };

    const report = await restoreProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      { createAdapter: () => adapter },
    );

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_TRANSACTION_MANAGED_DOCUMENT_CHANGED' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('restores owned settings without normalizing unrelated CRLF flow YAML or comments', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const settingsPath = join(dshHome, 'settings.yaml');
    const installed = await readFile(settingsPath, 'utf8');
    const customOffset = installed.indexOf('  custom:');
    expect(customOffset).toBeGreaterThanOrEqual(0);
    const custom = installed.slice(customOffset).replaceAll('\n', '\r\n');
    const unowned = [
      '# untouched root comment',
      'outside: {a: 1, b: 2} # untouched flow tail',
      'agent-presets:',
      '  existing: {model: keep, mode: strict} # untouched preset tail',
      '',
    ].join('\r\n');
    await writeFile(settingsPath, `${unowned}${custom}`);
    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(await readFile(settingsPath, 'utf8')).toBe(unowned);

    const restored = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(restored).toMatchObject({ exitCode: 0 });
    const after = await readFile(settingsPath, 'utf8');
    expect(after).toContain(
      '# untouched root comment\r\noutside: {a: 1, b: 2} # untouched flow tail\r\n',
    );
    expect(after).toContain('  existing: {model: keep, mode: strict} # untouched preset tail\r\n');
  });

  it('inverse-merges current owned settings before restoring target canonical values', async () => {
    const defaultHome = await home();
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true }),
          dshHome: defaultHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const defaultSettings = join(defaultHome, 'settings.yaml');
    await writeFile(
      defaultSettings,
      'agent-presets:\n  custom:\n    model: user-drift\nother-namespace:\n  untouched: true\n',
    );

    const retained = await restoreProfile({
      dshHome: defaultHome,
      profile: 'engine-pack',
      to: 1,
      yes: true,
    });

    expect(retained).toMatchObject({
      exitCode: 0,
      metadata: { retainedSettings: ['custom'] },
    });
    expect(await readFile(defaultSettings, 'utf8')).toContain('model: user-drift');

    const forceHome = await home();
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true }),
          dshHome: forceHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const forceSettings = join(forceHome, 'settings.yaml');
    await writeFile(
      forceSettings,
      'agent-presets:\n  custom:\n    model: user-drift\nother-namespace:\n  untouched: true\n',
    );

    const forced = await restoreProfile({
      dshHome: forceHome,
      profile: 'engine-pack',
      to: 1,
      force: true,
      yes: true,
    });

    expect(forced).toMatchObject({ exitCode: 0, metadata: { retainedSettings: [] } });
    const parsed = parseDocument(await readFile(forceSettings, 'utf8')).toJS() as Record<
      string,
      unknown
    >;
    expect(parsed['agent-presets']).toEqual({ custom: { model: 'fixture' } });
    expect(parsed['other-namespace']).toEqual({ untouched: true });
  });

  it.each([
    {
      name: 'the recorded key',
      remove: async (dshHome: string) =>
        writeFile(join(dshHome, 'settings.yaml'), 'agent-presets: {}\n'),
      existsAfterDefault: true,
    },
    {
      name: 'the complete settings document',
      remove: async (dshHome: string) => rm(join(dshHome, 'settings.yaml')),
      existsAfterDefault: false,
    },
  ])(
    'preserves a user deletion of $name by default and restores it only with --force',
    async ({ remove, existsAfterDefault }) => {
      const defaultHome = await home();
      await expect(
        installPack(
          {
            source: await enginePack({ assets: true }),
            dshHome: defaultHome,
            interactive: false,
            yes: true,
          },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      await remove(defaultHome);

      const retained = await restoreProfile({
        dshHome: defaultHome,
        profile: 'engine-pack',
        to: 1,
        yes: true,
      });

      expect(retained).toMatchObject({
        exitCode: 0,
        metadata: { retainedSettings: ['custom'], generation: 2 },
      });
      expect(await exists(join(defaultHome, 'settings.yaml'))).toBe(existsAfterDefault);
      if (existsAfterDefault)
        expect(
          parseDocument(await readFile(join(defaultHome, 'settings.yaml'), 'utf8')).toJS(),
        ).toEqual({
          'agent-presets': {},
        });
      const defaultGeneration = JSON.parse(
        await readFile(generationPath(defaultHome, 2), 'utf8'),
      ) as { metadata: { settingsContribution: { keys: unknown[] } } };
      expect(defaultGeneration.metadata.settingsContribution.keys).toEqual([]);

      const forceHome = await home();
      await expect(
        installPack(
          {
            source: await enginePack({ assets: true }),
            dshHome: forceHome,
            interactive: false,
            yes: true,
          },
          fakeRuntime().runtime,
        ),
      ).resolves.toMatchObject({ exitCode: 0 });
      await remove(forceHome);

      const forced = await restoreProfile({
        dshHome: forceHome,
        profile: 'engine-pack',
        to: 1,
        force: true,
        yes: true,
      });

      expect(forced).toMatchObject({
        exitCode: 0,
        metadata: { retainedSettings: [], generation: 2 },
      });
      expect(
        parseDocument(await readFile(join(forceHome, 'settings.yaml'), 'utf8')).toJS(),
      ).toEqual({
        'agent-presets': { custom: { model: 'fixture' } },
      });
      const forceGeneration = JSON.parse(await readFile(generationPath(forceHome, 2), 'utf8')) as {
        metadata: { settingsContribution: { keys: Array<{ key: string }> } };
      };
      expect(forceGeneration.metadata.settingsContribution.keys).toEqual([
        expect.objectContaining({ key: 'custom' }),
      ]);
    },
  );

  it('rechecks drift after the transaction lock before restoring over an asset', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 0,
    });
    const target = join(dshHome, 'skills', 'notes', 'SKILL.md');
    const base = createNodeTransactionAdapter();
    const adapter: TransactionAdapter = {
      ...base,
      async acquireArtifactLock(homePath) {
        const lock = await base.acquireArtifactLock(homePath);
        await writeFile(target, 'user-owned change after restore preflight\n');
        return lock;
      },
    };

    const report = await restoreProfile(
      { dshHome, profile: 'engine-pack', to: 2, yes: true },
      { createAdapter: () => adapter },
    );

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({ target: 'skills/notes', action: 'retain', reason: 'modified' }),
        ]),
      },
    });
    expect(await readFile(target, 'utf8')).toBe('user-owned change after restore preflight\n');
  });

  it('never force-replaces a target still claimed by another installed profile', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true, name: 'other-pack' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const peer = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'other-pack.json'), 'utf8'),
    ) as {
      assets: Array<{ target: string; action: string }>;
    };
    const peerSkill = peer.assets.find((asset) => asset.target === 'skills/notes');
    if (peerSkill === undefined) throw new Error('fixture must include the shared skill target');
    peerSkill.action = 'replace';
    await writeFile(
      join(dshHome, '.dshpack', 'installed', 'other-pack.json'),
      `${JSON.stringify(peer)}\n`,
    );
    const skill = join(dshHome, 'skills', 'notes', 'SKILL.md');
    await writeFile(skill, 'other profile still owns this target\n');

    const report = await restoreProfile({
      dshHome,
      profile: 'engine-pack',
      to: 1,
      force: true,
      yes: true,
    });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            action: 'retain',
            reason: 'shared-target',
          }),
        ]),
      },
    });
    expect(await readFile(skill, 'utf8')).toBe('other profile still owns this target\n');
  });

  it('treats a legacy peer marker as an unbounded shared-target claim', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true, name: 'other-pack' }),
          dshHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const peerPath = join(dshHome, '.dshpack', 'installed', 'other-pack.json');
    const peer = JSON.parse(await readFile(peerPath, 'utf8')) as Record<string, unknown>;
    delete peer.assets;
    delete peer.generation;
    delete peer.installedBy;
    delete peer.settingsContribution;
    peer.metadataVersion = 0;
    await writeFile(peerPath, `${JSON.stringify(peer)}\n`);
    const skill = join(dshHome, 'skills', 'notes', 'SKILL.md');
    await writeFile(skill, 'legacy peer safety hold\n');

    const report = await restoreProfile({
      dshHome,
      profile: 'engine-pack',
      to: 1,
      force: true,
      yes: true,
    });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            action: 'retain',
            reason: 'legacy-profile-reference',
          }),
        ]),
      },
    });
    expect(await readFile(skill, 'utf8')).toBe('legacy peer safety hold\n');
  });

  it('materializes absent restore targets despite an unrelated legacy peer marker', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const installed = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as Record<string, unknown>;
    await expect(
      uninstallProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const {
      assets: _assets,
      generation: _generation,
      installedBy: _installedBy,
      settingsContribution: _settingsContribution,
      ...legacyBase
    } = installed;
    await writeFile(
      join(dshHome, '.dshpack', 'installed', 'other-pack.json'),
      `${JSON.stringify({ ...legacyBase, metadataVersion: 0, profile: 'other-pack' })}\n`,
    );
    await rm(join(dshHome, 'profiles', 'engine-pack'), { force: true, recursive: true });
    await rm(join(dshHome, 'skills', 'notes'), { force: true, recursive: true });

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'profiles/engine-pack',
            action: 'materialize',
            reason: 'target-generation',
          }),
          expect.objectContaining({
            target: 'skills/notes',
            action: 'materialize',
            reason: 'target-generation',
          }),
        ]),
      },
    });
    expect(await exists(join(dshHome, 'profiles', 'engine-pack'))).toBe(true);
    expect(await readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain(
      '# Notes',
    );
  });

  it.each([
    {
      name: 'an absent installed-marker directory',
      mutate: async (dshHome: string) =>
        rm(join(dshHome, '.dshpack', 'installed'), { force: true, recursive: true }),
      exitCode: 0,
    },
    {
      name: 'a non-marker peer entry',
      mutate: async (dshHome: string) =>
        writeFile(join(dshHome, '.dshpack', 'installed', 'peer.txt'), 'not metadata\n'),
      exitCode: 30,
    },
    {
      name: 'a non-regular peer entry',
      mutate: async (dshHome: string) =>
        mkdir(join(dshHome, '.dshpack', 'installed', 'peer-pack.json'), { recursive: true }),
      exitCode: 31,
    },
    {
      name: 'an unsafe peer profile filename',
      mutate: async (dshHome: string) =>
        writeFile(join(dshHome, '.dshpack', 'installed', 'BAD.json'), '{}\n'),
      exitCode: 30,
    },
    {
      name: 'a malformed peer marker document',
      mutate: async (dshHome: string) =>
        writeFile(join(dshHome, '.dshpack', 'installed', 'peer-pack.json'), '{broken\n'),
      exitCode: 30,
    },
    {
      name: 'a peer marker with an invalid metadata contract',
      mutate: async (dshHome: string) =>
        writeFile(join(dshHome, '.dshpack', 'installed', 'peer-pack.json'), '{}\n'),
      exitCode: 30,
    },
  ])(
    'fails closed for $name during shared-target ownership scanning',
    async ({ mutate, exitCode }) => {
      const dshHome = await home();
      await installedThenUninstalled(dshHome);
      await mutate(dshHome);
      const before = await logicalSnapshot(dshHome);

      const report = await restoreProfile({
        dshHome,
        profile: 'engine-pack',
        dryRun: true,
        yes: true,
      });

      expect(report.exitCode).toBe(exitCode);
      if (exitCode === 30 || exitCode === 31)
        expect(report.diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'E_RESTORE_METADATA' })]),
        );
      expect(await logicalSnapshot(dshHome)).toEqual(before);
    },
  );

  it('replans a target created after the transaction lock before retaining or force-replacing it', async () => {
    const retainedHome = await home();
    await installedThenUninstalled(retainedHome);
    const retainedTarget = join(retainedHome, 'skills', 'notes', 'SKILL.md');
    const retainedBase = createNodeTransactionAdapter();
    const retainAdapter: TransactionAdapter = {
      ...retainedBase,
      async acquireArtifactLock(homePath) {
        const lock = await retainedBase.acquireArtifactLock(homePath);
        await mkdir(join(retainedTarget, '..'), { recursive: true });
        await writeFile(retainedTarget, 'user-created after lock\n');
        return lock;
      },
    };

    const retained = await restoreProfile(
      { dshHome: retainedHome, profile: 'engine-pack', yes: true },
      { createAdapter: () => retainAdapter },
    );

    expect(retained).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            action: 'retain',
            reason: 'untracked',
          }),
        ]),
      },
    });
    expect(await readFile(retainedTarget, 'utf8')).toBe('user-created after lock\n');

    const forcedHome = await home();
    await installedThenUninstalled(forcedHome);
    const forcedTarget = join(forcedHome, 'skills', 'notes', 'SKILL.md');
    const forcedBase = createNodeTransactionAdapter();
    const forceAdapter: TransactionAdapter = {
      ...forcedBase,
      async acquireArtifactLock(homePath) {
        const lock = await forcedBase.acquireArtifactLock(homePath);
        await mkdir(join(forcedTarget, '..'), { recursive: true });
        await writeFile(forcedTarget, 'force backup target created after lock\n');
        return lock;
      },
    };

    const forced = await restoreProfile(
      { dshHome: forcedHome, profile: 'engine-pack', force: true, yes: true },
      { createAdapter: () => forceAdapter, createTxid: () => 'restore-lock-force' },
    );

    expect(forced).toMatchObject({ exitCode: 0 });
    expect(await readFile(forcedTarget, 'utf8')).toBe(
      '---\nname: notes\ndescription: fixture notes\n---\n# Notes\n',
    );
    const backup = join(forcedHome, '.dshpack', 'backups', 'restore-lock-force', 'old');
    expect((await readdir(backup)).length).toBeGreaterThan(0);
  });

  it('rejects every unavailable restore target before it can mutate managed state', async () => {
    const initialHome = await home();
    await expect(
      installPack(
        {
          source: await enginePack({ assets: true }),
          dshHome: initialHome,
          interactive: false,
          yes: true,
        },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const initialBefore = await logicalSnapshot(initialHome);
    await expect(
      restoreProfile({ dshHome: initialHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_TARGET' })],
    });
    expect(await logicalSnapshot(initialHome)).toEqual(initialBefore);

    const missingHome = await home();
    await installedThenUninstalled(missingHome);
    const missingBefore = await logicalSnapshot(missingHome);
    await expect(
      restoreProfile({ dshHome: missingHome, profile: 'engine-pack', to: 99, yes: true }),
    ).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_TARGET' })],
    });
    expect(await logicalSnapshot(missingHome)).toEqual(missingBefore);

    const nonRestorableHome = await home();
    await installedThenUninstalled(nonRestorableHome);
    const path = generationPath(nonRestorableHome, 1);
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    document.restorable = false;
    await writeFile(path, `${JSON.stringify(document)}\n`);
    await expect(
      restoreProfile({ dshHome: nonRestorableHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_NOT_RESTORABLE' })],
    });
  });

  it('lists every missing CAS block before reporting a non-restorable target flag', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const path = generationPath(dshHome, 1);
    const generation = JSON.parse(await readFile(path, 'utf8')) as {
      restorable: boolean;
      entries: Array<{ sha256: string }>;
    };
    generation.restorable = false;
    const missing = [...new Set(generation.entries.map((entry) => entry.sha256))];
    await Promise.all(
      missing.map((digest) =>
        rm(join(dshHome, '.dshpack', 'store', digest.slice(7, 9), digest), { force: true }),
      ),
    );
    await writeFile(path, `${JSON.stringify(generation)}\n`);
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_CAS' })],
      metadata: { missingCasBlocks: expect.arrayContaining(missing) },
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('rejects corrupt effective-generation states before materializing their files', async () => {
    const uninstallHome = await home();
    await installedThenUninstalled(uninstallHome);
    const uninstallPath = generationPath(uninstallHome, 2);
    const uninstallGeneration = JSON.parse(await readFile(uninstallPath, 'utf8')) as {
      entries: Array<{ target: string; sha256: string }>;
    };
    const installed = JSON.parse(await readFile(generationPath(uninstallHome, 1), 'utf8')) as {
      entries: Array<{ target: string; sha256: string }>;
    };
    uninstallGeneration.entries = [installed.entries[0] as { target: string; sha256: string }];
    await writeFile(uninstallPath, `${JSON.stringify(uninstallGeneration)}\n`);
    await expect(
      restoreProfile({ dshHome: uninstallHome, profile: 'engine-pack', to: 2, yes: true }),
    ).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_GENERATION' })],
    });

    const foreignEntryHome = await home();
    await installedThenUninstalled(foreignEntryHome);
    const foreignPath = generationPath(foreignEntryHome, 1);
    const foreign = JSON.parse(await readFile(foreignPath, 'utf8')) as {
      entries: Array<{ target: string; sha256: string }>;
    };
    foreign.entries.push({
      target: 'unowned/file.txt',
      sha256: (foreign.entries[0] as { sha256: string }).sha256,
    });
    await writeFile(foreignPath, `${JSON.stringify(foreign)}\n`);
    await expect(
      restoreProfile({ dshHome: foreignEntryHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_GENERATION' })],
    });
  });

  it('fails closed for malformed current marker records and non-directory managed assets', async () => {
    const malformedHome = await home();
    await installedThenUninstalled(malformedHome);
    await expect(
      restoreProfile({ dshHome: malformedHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(malformedHome, '.dshpack', 'installed', 'engine-pack.json');
    await writeFile(markerPath, '{ definitely not json');
    await expect(
      restoreProfile({ dshHome: malformedHome, profile: 'engine-pack', to: 2, yes: true }),
    ).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_METADATA' })],
    });

    const fileHome = await home();
    await installedThenUninstalled(fileHome);
    await expect(
      restoreProfile({ dshHome: fileHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const skill = join(fileHome, 'skills', 'notes');
    await rm(skill, { recursive: true, force: true });
    await writeFile(skill, 'a user file replaces the managed directory\n');
    await expect(
      restoreProfile({ dshHome: fileHome, profile: 'engine-pack', to: 2, yes: true }),
    ).resolves.toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_ASSET_PATH' })],
    });
  });

  it('rejects a generation whose immutable entries do not exactly match metadata asset files', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const path = generationPath(dshHome, 1);
    const generation = JSON.parse(await readFile(path, 'utf8')) as {
      entries: Array<{ target: string; sha256: string }>;
      metadata: { assets: Array<{ target: string; files: Array<{ sha256: string }> }> };
    };
    const skill = generation.metadata.assets.find((asset) => asset.target === 'skills/notes');
    const foreignDigest = generation.entries.find(
      (entry) => entry.target !== 'skills/notes/SKILL.md',
    )?.sha256;
    if (skill === undefined || foreignDigest === undefined)
      throw new Error('fixture must provide a skill and an unrelated immutable entry');
    skill.files[0] = { ...skill.files[0], sha256: foreignDigest };
    await writeFile(path, `${JSON.stringify(generation)}\n`);
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_GENERATION' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('rejects target metadata whose declared file byte count disagrees with its CAS block', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const path = generationPath(dshHome, 1);
    const generation = JSON.parse(await readFile(path, 'utf8')) as {
      metadata: { assets: Array<{ target: string; files: Array<{ bytes: number }> }> };
    };
    const skill = generation.metadata.assets.find((asset) => asset.target === 'skills/notes');
    if (skill === undefined) throw new Error('fixture must contain the skill asset');
    const file = skill.files[0];
    if (file === undefined) throw new Error('fixture must contain the skill asset file');
    skill.files[0] = { ...file, bytes: file.bytes + 1 };
    await writeFile(path, `${JSON.stringify(generation)}\n`);
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_GENERATION' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('restores only absent settings keys while preserving the YAML shape of every conflict form', async () => {
    const scenarios = [
      {
        name: 'missing document',
        source: undefined,
        expected: (text: string) => text.startsWith('agent-presets:\n  custom:'),
      },
      {
        name: 'empty flow map',
        source: 'agent-presets: {}\n',
        expected: (text: string) => text.startsWith('agent-presets:\n  custom:'),
      },
      {
        name: 'existing owned key',
        source: 'agent-presets:\n  custom: user-owned\n',
        expected: (text: string) => text === 'agent-presets:\n  custom: user-owned\n',
      },
      {
        name: 'flow map with user key',
        source: 'agent-presets: {existing: keep}\n',
        expected: (text: string) => text === 'agent-presets: {existing: keep}\n',
      },
      {
        name: 'null section header',
        source: 'agent-presets:\n',
        expected: (text: string) => text.includes('agent-presets:\n  custom:'),
      },
      {
        name: 'unrelated root mapping',
        source: 'outside: preserved\n',
        expected: (text: string) => text.includes('outside: preserved\nagent-presets:\n  custom:'),
      },
    ] as const;
    for (const scenario of scenarios) {
      const dshHome = await home();
      await installedThenUninstalled(dshHome);
      const settingsPath = join(dshHome, 'settings.yaml');
      if (scenario.source === undefined) await rm(settingsPath, { force: true });
      else await writeFile(settingsPath, scenario.source);

      const report = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

      expect(report).toMatchObject({ exitCode: 0 });
      const restored = await readFile(settingsPath, 'utf8');
      expect(scenario.expected(restored), scenario.name).toBe(true);
    }
  }, 30_000);

  it('rejects invalid settings YAML and keeps a skip-owned current asset untouched', async () => {
    const settingsHome = await home();
    await installedThenUninstalled(settingsHome);
    await writeFile(join(settingsHome, 'settings.yaml'), 'agent-presets: [not valid\n');
    await expect(
      restoreProfile({ dshHome: settingsHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_SETTINGS' })],
    });

    const skipHome = await home();
    await installedThenUninstalled(skipHome);
    await expect(
      restoreProfile({ dshHome: skipHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(skipHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      assets: Array<{ target: string; action: string }>;
    };
    const skill = marker.assets.find((asset) => asset.target === 'skills/notes');
    if (skill === undefined) throw new Error('fixture must contain the skill asset');
    skill.action = 'skip';
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
    await synchronizeCurrentGenerationMarker(skipHome, marker);
    const retained = await restoreProfile({
      dshHome: skipHome,
      profile: 'engine-pack',
      to: 2,
      yes: true,
    });
    expect(retained).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            action: 'unchanged',
            reason: 'untracked',
          }),
        ]),
      },
    });
    expect(await exists(join(skipHome, 'skills', 'notes', 'SKILL.md'))).toBe(true);
  });

  it('handles inventory, invalid homes, legacy markers, and inaccessible settings as typed read-only outcomes', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', list: true }),
    ).resolves.toMatchObject({
      exitCode: 0,
      metadata: { generations: expect.any(Array) },
    });
    await expect(
      restoreProfile({ dshHome: 'relative-home', profile: 'engine-pack', list: true }),
    ).resolves.toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })],
    });

    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    marker.metadataVersion = 0;
    delete marker.assets;
    delete marker.settingsContribution;
    delete marker.generation;
    delete marker.installedBy;
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', to: 2, yes: true }),
    ).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_METADATA' })],
    });

    const settingsHome = await home();
    await installedThenUninstalled(settingsHome);
    const settingsPath = join(settingsHome, 'settings.yaml');
    await rm(settingsPath, { force: true });
    await mkdir(settingsPath, { recursive: true });
    await expect(
      restoreProfile({ dshHome: settingsHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_SETTINGS' })],
    });
  });

  it('keeps a missing current asset unchanged when restoring an uninstall generation', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    await expect(
      restoreProfile({ dshHome, profile: 'engine-pack', yes: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
    await rm(join(dshHome, 'skills', 'notes'), { force: true, recursive: true });

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', to: 2, yes: true });

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            target: 'skills/notes',
            action: 'unchanged',
            reason: 'target-absent',
          }),
        ]),
      },
    });
  });

  it('records a new uninstalled state when restoring an uninstalled generation with no marker', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);

    const report = await restoreProfile({
      dshHome,
      profile: 'engine-pack',
      to: 2,
      yes: true,
    });

    expect(report).toMatchObject({ exitCode: 0, metadata: { generation: 3 } });
    await expect(readFile(generationPath(dshHome, 3), 'utf8')).resolves.toContain(
      '"operation":"restore"',
    );
    await expect(
      readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when the current pointer and installed marker do not describe the same state', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const currentPath = join(dshHome, '.dshpack', 'generations', 'engine-pack', 'current');
    await writeFile(currentPath, '3\n');
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', to: 1, yes: true });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_CURRENT' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('fails closed when an installed current generation has no marker', async () => {
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    await rm(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'));
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({
      dshHome,
      profile: 'engine-pack',
      to: 1,
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_CURRENT' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('fails closed when an uninstalled current generation still has a marker', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const installed = JSON.parse(await readFile(generationPath(dshHome, 1), 'utf8')) as {
      metadata: unknown;
    };
    await writeFile(
      join(dshHome, '.dshpack', 'installed', 'engine-pack.json'),
      `${JSON.stringify(installed.metadata)}\n`,
    );
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({
      dshHome,
      profile: 'engine-pack',
      to: 1,
      dryRun: true,
    });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_CURRENT' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('refuses before mutation when effective metadata names an asset with no immutable entries', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const path = generationPath(dshHome, 1);
    const generation = JSON.parse(await readFile(path, 'utf8')) as {
      entries: Array<{ target: string }>;
    };
    generation.entries = generation.entries.filter(
      (entry) => !entry.target.startsWith('skills/notes/'),
    );
    await writeFile(path, `${JSON.stringify(generation)}\n`);
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile({ dshHome, profile: 'engine-pack', yes: true });

    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_RESTORE_GENERATION' })],
    });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('rolls back when strict post-restore doctor finds an error attributable to restored assets', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const before = await logicalSnapshot(dshHome);

    const report = await restoreProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      {
        async runDoctor() {
          return {
            diagnostics: [
              {
                code: 'DSH999',
                severity: 'error' as const,
                message: 'restored skill is invalid',
                hint: 'test only',
                evidence: 'local' as const,
                path: join(dshHome, 'skills', 'notes', 'SKILL.md'),
              },
            ],
            exitCode: EXIT_CODES.CONTRACT,
            metadata: { sideEffects: [] },
          };
        },
      },
    );

    expect(report).toMatchObject({ exitCode: 24 });
    expect(await logicalSnapshot(dshHome)).toEqual(before);
  });

  it('commits restore and warns when strict post-restore doctor only finds a foreign issue', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);

    const report = await restoreProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      {
        async runDoctor() {
          return {
            diagnostics: [
              {
                code: 'DSH998',
                severity: 'error' as const,
                message: 'another profile is invalid',
                hint: 'test only',
                evidence: 'local' as const,
                path: join(dshHome, 'skills', 'unrelated', 'SKILL.md'),
              },
            ],
            exitCode: EXIT_CODES.CONTRACT,
            metadata: { sideEffects: [] },
          };
        },
      },
    );

    expect(report).toMatchObject({ exitCode: 0 });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'W_RESTORE_DOCTOR_PREEXISTING' }),
    );
  });

  it('runs strict doctor without an install scope when restoring an uninstalled generation', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const runDoctor = vi.fn(async () => ({
      diagnostics: [
        {
          code: 'DSH998',
          severity: 'error' as const,
          message: 'unrelated issue',
          hint: 'test only',
          evidence: 'local' as const,
          path: join(dshHome, 'skills', 'unrelated', 'SKILL.md'),
        },
      ],
      exitCode: EXIT_CODES.CONTRACT,
      metadata: { sideEffects: [] },
    }));

    const report = await restoreProfile(
      { dshHome, profile: 'engine-pack', to: 2, yes: true },
      { runDoctor },
    );

    expect(report).toMatchObject({ exitCode: 0, metadata: { generation: 3 } });
    expect(runDoctor).toHaveBeenCalledWith({ dshHome, strict: true, yes: true, fix: false });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'W_RESTORE_DOCTOR_PREEXISTING' }),
    );
  });

  it.each(['throws', 'fails silently'] as const)(
    'rolls back when strict post-restore doctor %s',
    async (mode) => {
      const dshHome = await home();
      await installedThenUninstalled(dshHome);
      const before = await logicalSnapshot(dshHome);
      const runDoctor = vi.fn(async () => {
        if (mode === 'throws') throw new Error('doctor unavailable');
        return {
          diagnostics: [],
          exitCode: EXIT_CODES.CONTRACT,
          metadata: { sideEffects: [] },
        };
      });

      const report = await restoreProfile(
        { dshHome, profile: 'engine-pack', yes: true },
        { runDoctor },
      );

      expect(report).toMatchObject({ exitCode: 24 });
      expect(runDoctor).toHaveBeenCalledWith({
        dshHome,
        profile: 'engine-pack',
        strict: true,
        yes: true,
        fix: false,
      });
      expect(await logicalSnapshot(dshHome)).toEqual(before);
    },
  );

  it('reports the durable restore generation and recovery steps when post-commit lock release fails', async () => {
    const dshHome = await home();
    await installedThenUninstalled(dshHome);
    const base = createNodeTransactionAdapter();
    const adapter: TransactionAdapter = {
      ...base,
      async acquireArtifactLock(homePath) {
        const lock = await base.acquireArtifactLock(homePath);
        const release = lock.release.bind(lock);
        lock.release = async () => {
          await release();
          throw new Error('injected committed restore lock release failure');
        };
        return lock;
      },
    };

    const report = await restoreProfile(
      { dshHome, profile: 'engine-pack', yes: true },
      { createAdapter: () => adapter },
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      diagnostics: [
        expect.objectContaining({ code: 'E_TRANSACTION_ARTIFACT_LOCK_RELEASE_FAILED' }),
      ],
      metadata: {
        targetGeneration: 1,
        generation: 3,
        assets: expect.arrayContaining([
          expect.objectContaining({ target: 'skills/notes', action: 'materialize' }),
        ]),
        manualRecovery: [expect.objectContaining({ actionId: 'artifact-lock' })],
      },
    });
    await expect(
      readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ).resolves.toContain('"generation":3');
    await expect(readFile(generationPath(dshHome, 3), 'utf8')).resolves.toContain(
      '"operation":"restore"',
    );
  });
});
