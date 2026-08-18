import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectMetadata,
  inspectProfile,
  isAddressableProfileName,
  isInstallableProfileName,
  isReservedProfileName,
  MODULE_FALLBACK,
  presetExists,
} from '../src/list/contracts.js';
import { listProfiles } from '../src/list/engine.js';

const homes: string[] = [];
const SHA256_A = `sha256-${createHash('sha256').update('list fixture A').digest('base64url')}`;
const SHA256_B = `sha256-${createHash('sha256').update('list fixture B').digest('base64url')}`;
const SHA512 = `sha512-${createHash('sha512').update('list fixture SHA-512').digest('base64')}`;

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-list-'));
  homes.push(root);
  return root;
}

async function profile(root: string, name: string, overrides: Record<string, unknown> = {}) {
  const directory = join(root, 'profiles', name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      ...overrides,
    }),
    'utf8',
  );
  await writeFile(join(directory, 'cordis.patch.yml'), '[]\n', 'utf8');
  await writeFile(
    join(directory, 'pnpm-workspace.yaml'),
    "packages: ['.']\nnodeLinker: hoisted\nautoInstallPeers: false\n",
    'utf8',
  );
}

function marker(name: string) {
  return {
    metadataVersion: 0,
    profile: name,
    pack: { name: 'demo-pack', version: '1.2.3', manifestDigest: SHA256_A },
    planDigest: SHA256_B,
    installedAt: '2026-08-16T00:00:00.000Z',
    txid: 'tx-1',
    source: { kind: 'directory', path: resolve('fixture') },
    defaults: { agentPreset: 'demo-preset', permissionPreset: 'workspace-write' },
    plugins: [],
    effectiveLock: {
      lockVersion: 0,
      manifestSha256: SHA256_A,
      generatedBy: 'dshpack@0.0.0',
      generatedAt: '2026-08-16T00:00:00.000Z',
      dsh: { exportedFrom: '0.1.0-rc.6' },
      plugins: [],
      files: [],
    },
    sideEffects: ['profile/cordis.yml'],
  };
}

async function installed(root: string, name: string, value: unknown): Promise<void> {
  const directory = join(root, '.dshpack', 'installed');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify(value), 'utf8');
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const visit = async (root: string, prefix = ''): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(root, entry.name);
      if (entry.isDirectory()) await visit(path, relative);
      else output[relative] = entry.isFile() ? await readFile(path, 'utf8') : `<${entry.name}>`;
    }
  };
  await visit(directory);
  return output;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(homes.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('listProfiles', () => {
  it('joins profiles with installed metadata and never mutates the home', async () => {
    const root = await home();
    await profile(root, 'tracked');
    await profile(root, 'untracked');
    await installed(root, 'tracked', marker('tracked'));
    const before = await snapshot(root);

    const report = await listProfiles({ dshHome: root });

    expect(report.exitCode).toBe(0);
    expect(report.metadata.profiles).toEqual([
      {
        installedAt: '2026-08-16T00:00:00.000Z',
        pack: { name: 'demo-pack', version: '1.2.3' },
        profile: 'tracked',
        status: 'tracked',
      },
      { profile: 'untracked', status: 'untracked' },
    ]);
    expect(await snapshot(root)).toEqual(before);
  });

  it('lists a real dsh home the way dsh reads it, not the way a name check guesses', async () => {
    // Shape taken from a live DSH_HOME: pnpm's module fallback, an installed pack, and
    // the profile dsh ships and the user launches every day.
    const root = await home();
    await profile(root, 'research-writing');
    await installed(root, 'research-writing', marker('research-writing'));
    await profile(root, 'web');
    // Give the fallback a manifest of its own: dsh rejects the name outright, so the
    // structural test must not be what saves us here, or the name rule goes untested.
    await profile(root, MODULE_FALLBACK);
    await mkdir(join(root, 'profiles', MODULE_FALLBACK, 'dsh-at-file'), { recursive: true });

    const report = await listProfiles({ dshHome: root });

    expect(report.exitCode).toBe(0);
    expect(report.metadata.profiles).toEqual([
      expect.objectContaining({ profile: 'research-writing', status: 'tracked' }),
      expect.objectContaining({ profile: 'web', status: 'reserved' }),
    ]);
  });

  it('never lists profiles/node_modules, whether bare or carrying a manifest', async () => {
    const root = await home();
    const fallback = join(root, 'profiles', MODULE_FALLBACK);
    await mkdir(fallback, { recursive: true });

    await expect(listProfiles({ dshHome: root })).resolves.toMatchObject({
      metadata: { profiles: [] },
    });

    await writeFile(join(fallback, 'package.json'), JSON.stringify({ name: 'pnpm-store' }), 'utf8');
    await expect(listProfiles({ dshHome: root })).resolves.toMatchObject({
      metadata: { profiles: [] },
    });
  });

  it.each(['web', 'headless'])(
    'reports initialized reserved profile %s as reserved',
    async (name) => {
      const root = await home();
      await profile(root, name);

      await expect(listProfiles({ dshHome: root })).resolves.toMatchObject({
        metadata: {
          profiles: [
            {
              profile: name,
              status: 'reserved',
              reason: 'dsh 保留 profile，dshpack 不接管。',
            },
          ],
        },
      });
    },
  );

  it('reports a structurally malformed reserved profile as broken', async () => {
    const root = await home();
    await profile(root, 'web');
    await writeFile(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'not: an-array\n', 'utf8');

    await expect(listProfiles({ dshHome: root })).resolves.toMatchObject({
      metadata: {
        profiles: [
          {
            profile: 'web',
            status: 'broken',
            reason: 'profile cordis.patch.yml 顶层必须是 array。',
          },
        ],
      },
    });
  });

  it('leaves directories that were never profiles out instead of grading them', async () => {
    const root = await home();
    await profile(root, 'real');
    // A bare directory and a loose file: some other tool put them here.
    await mkdir(join(root, 'profiles', 'stray-dir'), { recursive: true });
    await writeFile(join(root, 'profiles', 'notes.md'), '# scratch\n', 'utf8');

    const report = await listProfiles({ dshHome: root });

    expect(report.metadata.profiles).toEqual([
      expect.objectContaining({ profile: 'real', status: 'untracked' }),
    ]);
  });

  it('reports a linked profile rather than dropping it for looking manifest-less', async () => {
    const root = await home();
    await profile(root, 'real');
    const target = join(root, 'elsewhere');
    await mkdir(target, { recursive: true });
    await symlink(target, join(root, 'profiles', 'linked'), 'junction');

    const report = await listProfiles({ dshHome: root });

    // Skipping it would be the quiet failure: a junction under profiles/ is a finding.
    expect(report.metadata.profiles).toEqual([
      expect.objectContaining({ profile: 'linked', status: 'broken' }),
      expect.objectContaining({ profile: 'real', status: 'untracked' }),
    ]);
  });

  it('still reports a directory dshpack claimed that stopped being a profile', async () => {
    const root = await home();
    await mkdir(join(root, 'profiles', 'gutted'), { recursive: true });
    await installed(root, 'gutted', marker('gutted'));

    const report = await listProfiles({ dshHome: root });

    expect(report.metadata.profiles).toEqual([
      expect.objectContaining({ profile: 'gutted', status: 'broken' }),
    ]);
  });

  it('marks malformed metadata, invalid profiles, and orphan markers broken', async () => {
    const root = await home();
    await profile(root, 'bad-meta');
    await installed(root, 'bad-meta', { ...marker('wrong'), profile: 'wrong' });
    await profile(root, 'bad-profile', { name: 'drifted-staging-name' });
    await installed(root, 'orphan', marker('orphan'));
    await profile(root, 'web');

    const report = await listProfiles({ dshHome: root });

    expect(report.exitCode).toBe(0);
    expect(report.metadata.profiles).toEqual([
      expect.objectContaining({ profile: 'bad-meta', status: 'broken' }),
      expect.objectContaining({ profile: 'bad-profile', status: 'broken' }),
      expect.objectContaining({ profile: 'orphan', status: 'broken' }),
      expect.objectContaining({ profile: 'web', status: 'reserved' }),
    ]);
    expect(
      report.metadata.profiles.map((entry) => ('reason' in entry ? entry.reason : undefined)),
    ).toEqual([
      'installed metadata 的 profile 与文件名不一致。',
      'profile package.json.name 与最终目录名不一致。',
      'installed metadata 对应的 profile 不存在。',
      'dsh 保留 profile，dshpack 不接管。',
    ]);
  });

  it('fails closed for an empty DSH_HOME and reports inaccessible roots as environment errors', async () => {
    await expect(listProfiles({ dshHome: '  ' })).resolves.toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_DSH_HOME_REQUIRED' })],
      metadata: { profiles: [] },
    });

    const root = await home();
    await writeFile(join(root, 'profiles'), 'not a directory', 'utf8');
    await expect(listProfiles({ dshHome: root })).resolves.toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_PATH_LIST_ROOT' })],
    });

    const markerRoot = await home();
    await mkdir(join(markerRoot, '.dshpack'), { recursive: true });
    await writeFile(join(markerRoot, '.dshpack', 'installed'), 'not a directory', 'utf8');
    await expect(listProfiles({ dshHome: markerRoot })).resolves.toMatchObject({
      exitCode: 31,
      diagnostics: [expect.objectContaining({ code: 'E_PATH_LIST_ROOT' })],
    });
  });

  it('returns an empty stable report and ignores non-JSON marker files', async () => {
    const root = await home();
    await expect(listProfiles({ dshHome: root })).resolves.toMatchObject({
      exitCode: 0,
      metadata: { profiles: [] },
    });
    await mkdir(join(root, '.dshpack', 'installed'), { recursive: true });
    await writeFile(join(root, '.dshpack', 'installed', 'README.txt'), 'ignored', 'utf8');
    await expect(listProfiles({ dshHome: root })).resolves.toMatchObject({
      metadata: { profiles: [] },
    });
  });

  it('treats incomplete profile contracts and malformed marker fields as broken', async () => {
    const root = await home();
    await profile(root, 'incomplete');
    await writeFile(join(root, 'profiles', 'incomplete', 'cordis.patch.yml'), 'not: an-array\n');
    await profile(root, 'bad-marker');
    await installed(root, 'bad-marker', {
      ...marker('bad-marker'),
      defaults: { permissionPreset: 'dangerous-by-pack' },
    });

    const report = await listProfiles({ dshHome: root });
    expect(report.metadata.profiles).toEqual([
      expect.objectContaining({
        profile: 'bad-marker',
        reason: 'installed metadata 格式不合法。',
        status: 'broken',
      }),
      expect.objectContaining({
        profile: 'incomplete',
        reason: 'profile cordis.patch.yml 顶层必须是 array。',
        status: 'broken',
      }),
    ]);
  });
});

describe('profile and metadata contracts', () => {
  it('owns only non-reserved 3–64 character kebab-case profile names', () => {
    expect(isInstallableProfileName('demo-profile')).toBe(true);
    for (const name of [
      'ab',
      `${'a'.repeat(64)}b`,
      'Bad',
      'bad--name',
      'web',
      'headless',
      'node_modules',
      '..',
      'a/b',
      'a\\b',
    ])
      expect(isInstallableProfileName(name)).toBe(false);
  });

  it('separates a name dshpack may own from a name that merely addresses a directory', () => {
    // web is dsh's own profile: unownable, but a perfectly ordinary directory name.
    for (const name of ['web', 'headless', 'node_modules', 'Bad', 'ab']) {
      expect(isInstallableProfileName(name)).toBe(false);
      expect(isAddressableProfileName(name)).toBe(true);
    }
    for (const name of ['', '.', '..', 'a/b', 'a\\b'])
      expect(isAddressableProfileName(name)).toBe(false);
    expect(isReservedProfileName('web')).toBe(true);
    expect(isReservedProfileName('headless')).toBe(true);
    expect(isReservedProfileName('demo-profile')).toBe(false);
  });

  it('rejects non-directories, junctions, and missing official base files', async () => {
    const root = await home();
    await mkdir(join(root, 'profiles'), { recursive: true });
    await writeFile(join(root, 'profiles', 'file-profile'), 'file', 'utf8');
    await expect(inspectProfile(root, 'file-profile')).resolves.toMatchObject({
      status: 'broken',
      failureKind: 'security',
    });

    const target = join(root, 'target-profile');
    await mkdir(target);
    await symlink(target, join(root, 'profiles', 'linked-profile'), 'junction');
    await expect(inspectProfile(root, 'linked-profile')).resolves.toMatchObject({
      status: 'broken',
      failureKind: 'security',
    });

    await mkdir(join(root, 'profiles', 'missing-base'));
    await expect(inspectProfile(root, 'missing-base')).resolves.toMatchObject({
      status: 'broken',
      reason: 'profile 缺少官方初始化基座文件。',
    });
  });

  it('rejects every malformed package and YAML profile contract', async () => {
    const root = await home();
    await profile(root, 'contract');
    const packagePath = join(root, 'profiles', 'contract', 'package.json');
    const valid = {
      name: 'dsh-profile-contract',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    };
    await writeFile(packagePath, '{broken', 'utf8');
    await expect(inspectProfile(root, 'contract')).resolves.toMatchObject({
      reason: 'profile package.json 不能解析。',
    });
    await writeFile(packagePath, '[]', 'utf8');
    await expect(inspectProfile(root, 'contract')).resolves.toMatchObject({
      reason: 'profile package.json 顶层必须是 object。',
    });
    const invalidManifests = [
      { ...valid, private: false },
      { ...valid, dependencies: [] },
      { ...valid, dependencies: { broken: 1 } },
      { ...valid, dsh: null },
      { ...valid, dsh: { profile: null } },
      { ...valid, dsh: { profile: { bundles: 'bad' } } },
      { ...valid, dsh: { profile: { bundles: ['ok', 1] } } },
      { ...valid, dsh: { profile: { bundles: ['same', 'same'] } } },
    ];
    for (const invalid of invalidManifests) {
      await writeFile(packagePath, JSON.stringify(invalid), 'utf8');
      await expect(inspectProfile(root, 'contract')).resolves.toMatchObject({
        reason: 'profile package.json 契约不合法。',
      });
    }
    await writeFile(packagePath, JSON.stringify(valid), 'utf8');
    const patch = join(root, 'profiles', 'contract', 'cordis.patch.yml');
    await writeFile(patch, '[unterminated', 'utf8');
    await expect(inspectProfile(root, 'contract')).resolves.toMatchObject({
      reason: 'profile cordis.patch.yml 顶层必须是 array。',
    });
    await writeFile(patch, '[]\n', 'utf8');
    const workspace = join(root, 'profiles', 'contract', 'pnpm-workspace.yaml');
    for (const value of ['[unterminated', '- item\n']) {
      await writeFile(workspace, value, 'utf8');
      await expect(inspectProfile(root, 'contract')).resolves.toMatchObject({
        reason: 'profile pnpm-workspace.yaml 不符合官方初始化基座。',
      });
    }
  });

  it('validates every InstalledMetadataV0 field and all source provenance variants', async () => {
    const root = await home();
    const write = (value: unknown) => installed(root, 'metadata', value);
    const valid = marker('metadata');
    for (const source of [
      { kind: 'directory', path: resolve('pack') },
      { kind: 'archive', path: resolve('pack.tgz') },
      { kind: 'https', url: 'https://example.test/pack.tgz', integrity: SHA512 },
      {
        kind: 'github',
        owner: 'owner',
        repo: 'repo',
        commit: 'a'.repeat(40),
        url: `https://codeload.github.com/owner/repo/tar.gz/${'a'.repeat(40)}`,
      },
    ]) {
      await write({ ...valid, source });
      expect((await inspectMetadata(root, 'metadata')).status).toBe('valid');
    }

    const invalid: unknown[] = [
      [],
      { ...valid, metadataVersion: 1 },
      { ...valid, pack: null },
      { ...valid, pack: { ...valid.pack, name: 1 } },
      { ...valid, pack: { ...valid.pack, name: 'web' } },
      { ...valid, pack: { ...valid.pack, version: 1 } },
      { ...valid, pack: { ...valid.pack, version: 'latest' } },
      { ...valid, pack: { ...valid.pack, manifestDigest: 1 } },
      { ...valid, pack: { ...valid.pack, manifestDigest: 'md5-x' } },
      { ...valid, planDigest: 1 },
      { ...valid, planDigest: 'md5-x' },
      { ...valid, installedAt: 1 },
      { ...valid, installedAt: 'never' },
      { ...valid, txid: 1 },
      { ...valid, txid: '' },
      { ...valid, source: null },
      { ...valid, source: { kind: 1 } },
      { ...valid, source: { kind: 'directory', path: 1 } },
      { ...valid, source: { kind: 'https', url: 1, integrity: 'x' } },
      { ...valid, source: { kind: 'https', url: 'https://x', integrity: 1 } },
      { ...valid, source: { kind: 'github', owner: 1, repo: 'r', commit: 'c', url: 'u' } },
      { ...valid, source: { kind: 'github', owner: 'o', repo: 1, commit: 'c', url: 'u' } },
      { ...valid, source: { kind: 'github', owner: 'o', repo: 'r', commit: 1, url: 'u' } },
      { ...valid, source: { kind: 'github', owner: 'o', repo: 'r', commit: 'c', url: 1 } },
      { ...valid, defaults: null },
      { ...valid, defaults: { permissionPreset: 'workspace-write', agentPreset: 1 } },
      { ...valid, defaults: { permissionPreset: 'workspace-write', agentPreset: 'standard' } },
      { ...valid, defaults: { permissionPreset: 'bad' } },
      { ...valid, plugins: null },
      { ...valid, sideEffects: null },
      { ...valid, sideEffects: [] },
      { ...valid, sideEffects: ['wrong'] },
    ];
    for (const value of invalid) {
      await write(value);
      expect((await inspectMetadata(root, 'metadata')).status).toBe('broken');
    }
    await writeFile(join(root, '.dshpack', 'installed', 'metadata.json'), '{bad', 'utf8');
    expect((await inspectMetadata(root, 'metadata')).status).toBe('broken');
  });

  it('validates preset ids and requires a regular agent.cordis.yml', async () => {
    const root = await home();
    expect(await presetExists(root, 'standard')).toBe(false);
    expect(await presetExists(root, 'Bad')).toBe(false);
    expect(await presetExists(root, 'missing')).toBe(false);
    await mkdir(join(root, '.agent-presets', 'valid-preset'), { recursive: true });
    await writeFile(join(root, '.agent-presets', 'valid-preset', 'agent.cordis.yml'), '[]\n');
    expect(await presetExists(root, 'valid-preset')).toBe(true);
  });
});
