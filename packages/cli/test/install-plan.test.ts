import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { prepareInstallPlan } from '../src/install/plan.js';
import {
  commit,
  directoryBytes,
  fixture,
  input,
  integrity,
  lockedPlugin,
  manifest,
  targetBeforeState,
} from './install-plan-fixture.js';

describe('prepareInstallPlan', () => {
  it('builds a stable V0 review plan without writing source or DSH_HOME', async () => {
    const root = await fixture();
    const dshHome = join(tmpdir(), `absent-plan-home-${crypto.randomUUID()}`);
    const before = await directoryBytes(root);
    const target = targetBeforeState();
    const result = await prepareInstallPlan(
      input(root, {
        source: {
          directory: root,
          provenance: {
            kind: 'github',
            owner: 'dsh-packs',
            repo: 'research',
            commit,
            url: `https://codeload.github.com/dsh-packs/research/tar.gz/${commit}`,
          },
        },
        environment: {
          dshHome,
          dshVersion: '0.1.0-rc.6',
          pnpmVersion: '11.7.0',
          profileExists: false,
          interactive: false,
          targetBeforeState: target.state,
          targetBeforeStateDigest: target.digest,
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.plan).toMatchObject({
      planVersion: 0,
      targetProfile: 'research-pack',
      pack: { name: 'research-pack', version: '1.0.0' },
      plugins: [
        {
          name: 'example-bundle',
          exactSpec: 'example-bundle@1.2.3',
          integrity: { kind: 'npm-sri', value: integrity },
          effectiveAt: '重启生效',
        },
      ],
      source: { kind: 'github', commit },
      sideEffects: [
        { path: 'profiles/research-pack/cordis.yml', reason: 'dsh --dump-config（E9）' },
      ],
      requiredDangerousPermissions: [],
      authorizedDangerousPermissions: [],
    });
    expect(result.plan?.planDigest).toMatch(/^sha256-[A-Za-z0-9_-]+$/u);
    expect(result.plan?.manifestDigest).toMatch(/^sha256-[A-Za-z0-9_-]+$/u);
    expect(await directoryBytes(root)).toEqual(before);
    await expect(stat(dshHome)).rejects.toMatchObject({ code: 'ENOENT' });

    const repeatedInput = input(root);
    const repeated = await prepareInstallPlan(repeatedInput);
    const repeatedAgain = await prepareInstallPlan(repeatedInput);
    expect(repeated.plan?.planDigest).toBe(repeatedAgain.plan?.planDigest);
  });

  it('derives exact locked specs for npm, GitHub, and tarball sources', async () => {
    const cases = [
      {
        source: { kind: 'npm' as const, range: '^1.2.0' },
        locked: lockedPlugin(),
        spec: 'example-bundle@1.2.3',
      },
      {
        source: { kind: 'github' as const, owner: 'owner', repo: 'repo', ref: commit },
        locked: lockedPlugin({
          resolved: { commit },
          integrity: { kind: 'git-commit', value: commit },
        }),
        spec: `github:owner/repo#${commit}`,
      },
      {
        source: { kind: 'tarball' as const, url: 'https://example.com/bundle.tgz' },
        locked: lockedPlugin({
          resolved: { url: 'https://example.com/bundle.tgz' },
          integrity: { kind: 'sha512', value: integrity },
        }),
        spec: 'https://example.com/bundle.tgz',
      },
    ];
    for (const current of cases) {
      const root = await fixture({
        manifest: manifest({ source: current.source }),
        locked: current.locked,
      });
      const result = await prepareInstallPlan(input(root));
      expect(result.plan?.plugins[0]?.exactSpec).toBe(current.spec);
    }
  });

  it.each([
    [
      'npm range',
      { source: { kind: 'npm' as const, range: '^2.0.0' } },
      lockedPlugin(),
      'E_LOCK_NPM_RANGE',
    ],
    [
      'GitHub commit',
      { source: { kind: 'github' as const, owner: 'owner', repo: 'repo', ref: commit } },
      lockedPlugin({
        resolved: { commit: 'f'.repeat(40) },
        integrity: { kind: 'git-commit', value: 'f'.repeat(40) },
      }),
      'E_LOCK_GITHUB_COMMIT',
    ],
    [
      'tarball URL',
      { source: { kind: 'tarball' as const, url: 'https://example.com/a.tgz' } },
      lockedPlugin({
        resolved: { url: 'https://example.com/b.tgz' },
        integrity: { kind: 'sha512', value: integrity },
      }),
      'E_LOCK_TARBALL_URL',
    ],
  ])('rejects a %s mismatch as source integrity failure', async (_name, plugin, locked, code) => {
    const root = await fixture({ manifest: manifest(plugin), locked });
    const result = await prepareInstallPlan(input(root));
    expect(result.exitCode).toBe(20);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
    expect(result.plan).toBeUndefined();
  });

  it('requires a frozen lock and never permits an unverified tarball', async () => {
    const absent = await prepareInstallPlan(input(await fixture({ omitLock: true })));
    expect(absent.exitCode).toBe(20);
    expect(absent.plan).toBeUndefined();
    expect(absent.diagnostics).toContainEqual(expect.objectContaining({ code: 'E_NO_LOCK' }));

    const source = { kind: 'tarball' as const, url: 'https://example.com/a.tgz' };
    const root = await fixture({
      manifest: manifest({ source }),
      locked: lockedPlugin({
        resolved: { url: source.url },
        integrity: { kind: 'unverified', reason: 'legacy export' },
      }),
    });
    const rejected = await prepareInstallPlan(
      input(root, { options: { sourceArgument: root, yes: true, allowUnverified: true } }),
    );
    expect(rejected.exitCode).toBe(20);
    expect(rejected.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_LOCK_TARBALL_INTEGRITY' }),
    );
  });

  it('requires --allow-unverified independently of --yes for npm', async () => {
    const root = await fixture({
      locked: lockedPlugin({ integrity: { kind: 'unverified', reason: 'no registry digest' } }),
    });
    const rejected = await prepareInstallPlan(input(root));
    expect(rejected.exitCode).toBe(20);
    expect(rejected.diagnostics[0]).toMatchObject({ code: 'E_UNVERIFIED_REQUIRED' });
    const allowed = await prepareInstallPlan(
      input(root, { options: { sourceArgument: root, yes: true, allowUnverified: true } }),
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.plan?.plugins[0]?.integrity.kind).toBe('unverified');
  });

  it('rejects an existing profile unless --replace itself is present', async () => {
    const root = await fixture();
    const environment = {
      dshHome: join(tmpdir(), `plan-home-${crypto.randomUUID()}`),
      dshVersion: '0.1.0-rc.6',
      pnpmVersion: '11.7.0',
      profileExists: true,
      interactive: false,
      targetBeforeState: targetBeforeState('research-pack', { profilePresent: true }).state,
      targetBeforeStateDigest: targetBeforeState('research-pack', { profilePresent: true }).digest,
    };
    const rejected = await prepareInstallPlan(
      input(root, { options: { sourceArgument: root, yes: true }, environment }),
    );
    expect(rejected.exitCode).toBe(22);
    expect(rejected.diagnostics[0]).toMatchObject({ code: 'E_PROFILE_EXISTS' });

    const allowed = await prepareInstallPlan(
      input(root, { options: { sourceArgument: root, yes: true, replace: true }, environment }),
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.plan?.replaceExistingProfile).toBe(true);
  });

  it('lists every allowBuilds package and --yes cannot authorize any of them', async () => {
    const pack = manifest({ allowBuilds: true });
    pack.plugins.push({
      name: 'second-bundle',
      source: { kind: 'npm', range: '2.x' },
      allowBuilds: true,
    });
    const second = { ...lockedPlugin(), name: 'second-bundle', resolved: { version: '2.4.0' } };
    const root = await fixture({ manifest: pack });
    const lockPath = join(root, 'pack.lock.yml');
    const lockText = await readFile(lockPath, 'utf8');
    const parsed = (await import('yaml')).parse(lockText) as Record<string, unknown>;
    parsed.plugins = [lockedPlugin(), second];
    await writeFile(lockPath, stringify(parsed, { lineWidth: 0 }));

    const rejected = await prepareInstallPlan(input(root));
    expect(rejected.exitCode).toBe(21);
    expect(rejected.decision).toMatchObject({
      status: 'rejected',
      missingAllowBuilds: ['example-bundle', 'second-bundle'],
    });
    expect(rejected.decision.nonInteractiveCommand).toContain("--allow-build 'example-bundle'");
    expect(rejected.decision.nonInteractiveCommand).toContain("--allow-build 'second-bundle'");

    const allowed = await prepareInstallPlan(
      input(root, {
        options: {
          sourceArgument: root,
          yes: true,
          allowBuilds: ['second-bundle', 'example-bundle'],
        },
      }),
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.plan?.allowBuilds).toEqual(['example-bundle', 'second-bundle']);
  });

  it('does not turn pack danger-full-access into authorization', async () => {
    const pack = manifest();
    pack.defaults.permissionPreset = 'danger-full-access';
    const root = await fixture({ manifest: pack });
    const rejected = await prepareInstallPlan(input(root));
    expect(rejected.exitCode).toBe(21);
    expect(rejected.plan).toMatchObject({
      requiredDangerousPermissions: ['danger-full-access'],
      authorizedDangerousPermissions: [],
    });
    expect(rejected.decision.nonInteractiveCommand).toContain('--allow-danger-full-access');

    const allowed = await prepareInstallPlan(
      input(root, {
        options: { sourceArgument: root, yes: true, allowDangerFullAccess: true },
      }),
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.plan?.authorizedDangerousPermissions).toEqual(['danger-full-access']);
  });

  it('requires both flags for a non-interactive dsh version mismatch', async () => {
    const root = await fixture();
    const base = input(root);
    const environment = { ...base.environment, dshVersion: '0.2.0', interactive: false };
    for (const options of [
      { sourceArgument: root, yes: true },
      { sourceArgument: root, allowVersionMismatch: true },
    ]) {
      const rejected = await prepareInstallPlan(input(root, { options, environment }));
      expect(rejected.exitCode).toBe(21);
      expect(rejected.decision.nonInteractiveCommand).toContain('--allow-version-mismatch');
      expect(rejected.decision.nonInteractiveCommand).toContain('--yes');
    }
    const allowed = await prepareInstallPlan(
      input(root, {
        options: { sourceArgument: root, yes: true, allowVersionMismatch: true },
        environment,
      }),
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.plan?.dsh.versionMismatch).toBe(true);
  });

  it('expresses interactive prompts with refusal defaults and dry-run bypasses authorization', async () => {
    const root = await fixture({ manifest: manifest({ allowBuilds: true }) });
    const base = input(root);
    const interactive = await prepareInstallPlan(
      input(root, {
        options: { sourceArgument: root },
        environment: { ...base.environment, interactive: true },
      }),
    );
    expect(interactive.exitCode).toBe(0);
    expect(interactive.decision.status).toBe('requires-interaction');
    expect(interactive.decision.prompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'allow-build', defaultValue: false }),
        expect.objectContaining({ kind: 'install', defaultValue: false }),
      ]),
    );

    const dryRun = await prepareInstallPlan(
      input(root, { options: { sourceArgument: root, dryRun: true } }),
    );
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.decision.status).toBe('review-only');
    expect(dryRun.plan?.allowBuilds).toEqual(['example-bundle']);
  });

  it('rejects unsafe target profiles and invalid DSH_HOME before reading the pack', async () => {
    const missing = join(tmpdir(), `missing-pack-${crypto.randomUUID()}`);
    const emptyHome = await prepareInstallPlan(
      input(missing, {
        environment: {
          dshHome: '',
          dshVersion: '0.1.0-rc.6',
          pnpmVersion: '11.7.0',
          profileExists: false,
          interactive: false,
          targetBeforeState: targetBeforeState().state,
          targetBeforeStateDigest: targetBeforeState().digest,
        },
      }),
    );
    expect(emptyHome.exitCode).toBe(10);
    expect(emptyHome.plan).toBeUndefined();
    expect(emptyHome.diagnostics[0]).toMatchObject({ code: 'E_DSH_HOME' });

    const root = await fixture();
    const unsafe = await prepareInstallPlan(
      input(root, { options: { sourceArgument: root, as: '../escape', yes: true } }),
    );
    expect(unsafe.exitCode).toBe(31);
    expect(unsafe.plan).toBeUndefined();
    expect(unsafe.diagnostics[0]).toMatchObject({ code: 'E_PROFILE_PATH' });
  });

  it('enumerates managed assets, settings, and their activation timing', async () => {
    const pack = manifest();
    pack.settings = { namespaces: { 'agent-presets': 'agent-presets.yml' } };
    pack.defaults.agentPreset = 'custom';
    pack.mcp.push({
      serverName: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
    });
    const root = await fixture({
      manifest: pack,
      files: {
        'skills/notes.md': '---\nname: notes\ndescription: notes helper\n---\n# Notes\n',
        'skills/folder/SKILL.md': '---\nname: folder\ndescription: folder helper\n---\n# Folder\n',
        'presets/custom/agent.cordis.yml': '[]\n',
        'settings/agent-presets.yml': 'custom: {}\n',
      },
    });
    const target = targetBeforeState('research-pack', {
      skills: [
        { path: 'skills/folder', state: 'absent' },
        { path: 'skills/notes', state: 'absent' },
      ],
      presets: [{ path: '.agent-presets/custom', state: 'absent' }],
    });
    const environment = {
      ...input(root).environment,
      targetBeforeState: target.state,
      targetBeforeStateDigest: target.digest,
    };
    const result = await prepareInstallPlan(input(root, { environment }));
    expect(result.exitCode, JSON.stringify(result.diagnostics)).toBe(0);
    expect(result.plan?.skills.map(({ id }) => id)).toEqual(['folder', 'notes']);
    expect(result.plan?.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'skills/notes', effectiveAt: '热生效' }),
        expect.objectContaining({ path: '.agent-presets/custom', effectiveAt: '新会话生效' }),
        expect.objectContaining({ path: 'settings.yaml', effectiveAt: '新会话生效' }),
        expect.objectContaining({
          path: 'profiles/research-pack/cordis.patch.yml',
          effectiveAt: '重启生效',
        }),
      ]),
    );
    const forced = await prepareInstallPlan(
      input(root, { options: { sourceArgument: root, yes: true, force: true }, environment }),
    );
    expect(forced.plan?.writes.filter(({ kind }) => kind === 'skill' || kind === 'preset')).toEqual(
      expect.arrayContaining([expect.objectContaining({ policy: 'create-or-replace' })]),
    );
  });
});
