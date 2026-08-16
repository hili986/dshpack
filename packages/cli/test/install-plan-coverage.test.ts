import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Diagnostic, PackLockedPlugin, PackManifest, PluginDeclaration } from '@dshpack/core';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { prepareInstallPlan } from '../src/install/plan.js';
import { readValidatedPack, validationExitCode } from '../src/install/read.js';
import { reconcileLockedPlugin } from '../src/install/reconcile.js';
import type { PrepareInstallPlanInput } from '../src/install/types.js';

const sri = `sha512-${Buffer.alloc(64, 3).toString('base64')}`;
const commit = '0123456789abcdef0123456789abcdef01234567';
const fileDigest = (text: string): string =>
  `sha512-${createHash('sha512').update(text).digest('base64')}`;

function npmDeclaration(overrides: Partial<PluginDeclaration> = {}): PluginDeclaration {
  return {
    name: 'example-bundle',
    source: { kind: 'npm', range: '^1.0.0' },
    allowBuilds: false,
    ...overrides,
  };
}

function lock(overrides: Partial<PackLockedPlugin> = {}): PackLockedPlugin {
  return {
    name: 'example-bundle',
    resolved: { version: '1.2.0' },
    integrity: { kind: 'npm-sri', value: sri },
    packageJsonSha512: sri,
    bundlePatch: 'cordis.patch.yml',
    ...overrides,
  };
}

async function smallFixture(
  options: { settingsFile?: string; allowBuilds?: boolean } = {},
): Promise<string> {
  const root = join(tmpdir(), `dshpack-plan-cov-${crypto.randomUUID()}`);
  await mkdir(join(root, 'patch'), { recursive: true });
  const manifest: PackManifest = {
    formatVersion: 0,
    name: 'coverage-pack',
    version: '1.0.0',
    description: 'coverage',
    author: 'tester',
    license: 'MIT',
    dsh: { tested: ['0.1.0-rc.6'] },
    plugins: [npmDeclaration({ allowBuilds: options.allowBuilds ?? false })],
    mcp: [],
    defaults: { permissionPreset: 'workspace-write' },
    ...(options.settingsFile === undefined
      ? {}
      : { settings: { namespaces: { 'agent-presets': options.settingsFile } } }),
  };
  const manifestText = stringify(manifest, { lineWidth: 0 });
  const patch = '[]\n';
  const packLock = {
    lockVersion: 0,
    manifestSha256: `sha256-${createHash('sha256').update(manifestText).digest('base64url')}`,
    generatedBy: 'dshpack@test',
    generatedAt: '2026-08-16T00:00:00Z',
    dsh: { exportedFrom: '0.1.0-rc.6' },
    plugins: [lock()],
    files: [{ path: 'patch/cordis.patch.yml', sha512: fileDigest(patch) }],
  };
  await writeFile(join(root, 'pack.yml'), manifestText);
  await writeFile(join(root, 'pack.lock.yml'), stringify(packLock, { lineWidth: 0 }));
  await writeFile(join(root, 'patch', 'cordis.patch.yml'), patch);
  return root;
}

function planInput(directory: string): PrepareInstallPlanInput {
  return {
    source: { directory, provenance: { kind: 'directory', path: directory } },
    options: { sourceArgument: 'C:/source with space/"pack"', yes: true },
    environment: {
      dshHome: join(tmpdir(), `dshpack-home-${crypto.randomUUID()}`),
      dshVersion: '0.1.0-rc.6',
      pnpmVersion: '11.7.0',
      profileExists: false,
      interactive: false,
    },
  };
}

describe('install plan defensive branches', () => {
  it('maps validation diagnostics without downgrading security or source failures', () => {
    const item = (code: string): Diagnostic => ({
      code,
      severity: 'error',
      message: code,
      hint: code,
      evidence: 'local',
    });
    expect(validationExitCode([item('E_PATH_ESCAPE')])).toBe(31);
    expect(validationExitCode([item('E_SOURCE_READ')])).toBe(20);
    expect(validationExitCode([item('E_SCHEMA_TYPE')])).toBe(30);
  });

  it('fails closed when validated bytes disappear or change before the second read', async () => {
    const valid = async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: { source: 'x', valid: true },
    });
    const common = {
      accessFile: async () => undefined,
      validate: valid,
      listPaths: async () => [],
    };
    const changed = await readValidatedPack('C:/pack', {
      ...common,
      readText: async () => 'not: a valid pack',
    });
    expect(changed.exitCode).toBe(30);
    const disappeared = await readValidatedPack('C:/pack', {
      ...common,
      readText: async () => {
        throw new Error('injected race');
      },
    });
    expect(disappeared).toMatchObject({ exitCode: 20 });
    expect(disappeared.diagnostics[0]).toMatchObject({ code: 'E_SOURCE_READ', path: 'C:/pack' });
  });

  it.each([
    [npmDeclaration(), lock({ name: 'other' }), 'E_LOCK_PLUGIN_NAME'],
    [npmDeclaration(), lock({ resolved: { commit } }), 'E_LOCK_NPM_RESOLUTION'],
    [npmDeclaration({ source: { kind: 'npm', range: '[' } }), lock(), 'E_PLUGIN_NPM_RANGE'],
    [
      npmDeclaration(),
      lock({ integrity: { kind: 'git-commit', value: commit } }),
      'E_LOCK_NPM_INTEGRITY',
    ],
    [npmDeclaration(), lock({ bundlePatch: '../escape.yml' }), 'E_LOCK_BUNDLE_PATCH_PATH'],
    [
      npmDeclaration({ source: { kind: 'github', owner: 'o', repo: 'r', ref: commit } }),
      lock({ resolved: { commit }, integrity: { kind: 'npm-sri', value: sri } }),
      'E_LOCK_GITHUB_COMMIT',
    ],
    [
      npmDeclaration({ source: { kind: 'github', owner: 'o', repo: 'r', ref: commit } }),
      lock({ resolved: { commit }, integrity: { kind: 'git-commit', value: 'f'.repeat(40) } }),
      'E_LOCK_GITHUB_COMMIT',
    ],
    [
      npmDeclaration({ source: { kind: 'tarball', url: 'not-a-url' } }),
      lock({
        resolved: { url: 'https://example.com/a.tgz' },
        integrity: { kind: 'sha512', value: sri },
      }),
      'E_PLUGIN_TARBALL_URL',
    ],
    [
      npmDeclaration({ source: { kind: 'tarball', url: 'https://example.com/a.tgz' } }),
      lock({ resolved: { version: '1.0.0' }, integrity: { kind: 'sha512', value: sri } }),
      'E_LOCK_TARBALL_URL',
    ],
  ])('rejects inconsistent source facts %#', (declaration, locked, code) => {
    expect(reconcileLockedPlugin(declaration, locked).diagnostics[0]).toMatchObject({ code });
  });

  it('covers environment, materialization, settings, and exact-build guards', async () => {
    const missing = 'C:/missing';
    const base = planInput(missing);
    for (const environment of [
      { ...base.environment, dshVersion: '' },
      { ...base.environment, pnpmVersion: '' },
    ]) {
      const result = await prepareInstallPlan({ ...base, environment });
      expect(result.exitCode).toBe(10);
    }
    const relative = await prepareInstallPlan({
      ...base,
      source: { directory: 'relative', provenance: { kind: 'directory', path: 'relative' } },
    });
    expect(relative.exitCode).toBe(20);

    const badSettings = await prepareInstallPlan(
      planInput(await smallFixture({ settingsFile: 'other.yml' })),
    );
    expect(badSettings).toMatchObject({ exitCode: 30 });
    expect(badSettings.diagnostics[0]).toMatchObject({ code: 'E_SETTINGS_SOURCE' });

    const missingSettings = await prepareInstallPlan(
      planInput(await smallFixture({ settingsFile: 'agent-presets.yml' })),
    );
    expect(missingSettings).toMatchObject({ exitCode: 30 });
    expect(missingSettings.diagnostics[0]).toMatchObject({ code: 'E_SETTINGS_SOURCE_MISSING' });

    const build = planInput(await smallFixture({ allowBuilds: true }));
    build.options = { ...build.options, allowBuilds: ['not-requested'] };
    const unknown = await prepareInstallPlan(build);
    expect(unknown).toMatchObject({ exitCode: 30 });
    expect(unknown.diagnostics[0]).toMatchObject({ code: 'E_ALLOW_BUILD_UNKNOWN' });
  });

  it('quotes non-interactive commands and plans force overwrite explicitly', async () => {
    const root = await smallFixture();
    const value = planInput(root);
    value.options = { ...value.options, force: true };
    const result = await prepareInstallPlan(value);
    expect(result.exitCode).toBe(0);
    expect(result.decision.nonInteractiveCommand).toContain('"C:/source with space/\\"pack\\""');
    expect(result.decision.nonInteractiveCommand).toContain('--force');
  });
});
