import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { prepareInstallPlan } from '../src/install/plan.js';
import { readValidatedPack, validationExitCode } from '../src/install/read.js';
import { fixture, input, manifest, targetBeforeState } from './install-plan-fixture.js';

const sha256 = (value: unknown): string =>
  `sha256-${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}`;

describe('install plan review mutants', () => {
  it('validates the exact private snapshot bytes even when the source performs an A→B→A ABA', async () => {
    const sourceA = await fixture();
    const changedManifest = manifest();
    changedManifest.description = 'different but still valid';
    const sourceB = await fixture({ manifest: changedManifest });
    const originalManifest = await readFile(join(sourceA, 'pack.yml'));
    const originalLock = await readFile(join(sourceA, 'pack.lock.yml'));
    let observedDescription: string | undefined;

    const result = await readValidatedPack(sourceA, {
      validate: async (validatedDirectory) => {
        await copyFile(join(sourceB, 'pack.yml'), join(sourceA, 'pack.yml'));
        await copyFile(join(sourceB, 'pack.lock.yml'), join(sourceA, 'pack.lock.yml'));
        observedDescription = (
          parse(await readFile(join(validatedDirectory, 'pack.yml'), 'utf8')) as {
            description?: string;
          }
        ).description;
        await writeFile(join(sourceA, 'pack.yml'), originalManifest);
        await writeFile(join(sourceA, 'pack.lock.yml'), originalLock);
        return { diagnostics: [], exitCode: 0, metadata: { source: sourceA, valid: true } };
      },
    });

    expect(result.material).toBeDefined();
    expect(observedDescription).toBe('test pack');
    expect(result.material?.manifest.description).toBe('test pack');
  });

  it('fails closed when the private validation snapshot cannot be cleaned', async () => {
    const root = await fixture();
    const result = await readValidatedPack(root, {
      removeTempDirectory: async () => {
        throw new Error('injected cleanup failure');
      },
    });

    expect(result).toMatchObject({ exitCode: 20 });
    expect(result.material).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: 'E_SOURCE_SNAPSHOT_CLEANUP' });
  });

  it('rejects hostile file count and size before validator execution', async () => {
    let validated = false;
    let reads = 0;
    const common = {
      accessFile: async () => undefined,
      validate: async () => {
        validated = true;
        return { diagnostics: [], exitCode: 0 as const, metadata: { source: 'x', valid: true } };
      },
    };
    const tooMany = await readValidatedPack('C:/pack', {
      ...common,
      listPaths: async () => Array.from({ length: 1001 }, (_, index) => `files/${index}.md`),
      readBytes: async () => {
        reads += 1;
        return Buffer.from('x');
      },
    });
    expect(tooMany).toMatchObject({ exitCode: 20 });
    expect(tooMany.diagnostics[0]).toMatchObject({ code: 'E_SOURCE_SNAPSHOT_LIMIT' });
    expect(reads).toBe(0);
    expect(validated).toBe(false);

    const tooLarge = await readValidatedPack('C:/pack', {
      ...common,
      listPaths: async () => ['large.bin'],
      readBytes: async () => Buffer.alloc(1024 * 1024 + 1),
    });
    expect(tooLarge).toMatchObject({ exitCode: 20 });
    expect(tooLarge.diagnostics[0]).toMatchObject({ code: 'E_SOURCE_SNAPSHOT_LIMIT' });
    expect(validated).toBe(false);

    const totalTooLarge = await readValidatedPack('C:/pack', {
      ...common,
      listPaths: async () => Array.from({ length: 11 }, (_, index) => `files/${index}.bin`),
      readBytes: async () => Buffer.alloc(1024 * 1024),
    });
    expect(totalTooLarge).toMatchObject({ exitCode: 20 });
    expect(totalTooLarge.diagnostics[0]).toMatchObject({ code: 'E_SOURCE_SNAPSHOT_LIMIT' });
    expect(validated).toBe(false);
  });

  it('binds every verified source byte so later payload mutation cannot change apply input', async () => {
    const root = await fixture();
    const result = await readValidatedPack(root);
    expect(result.material).toBeDefined();
    const material = result.material as NonNullable<typeof result.material> & {
      files: readonly { path: string; contentBase64: string }[];
      lockDigest: string;
      sourceFiles: readonly { path: string; sha512: string }[];
    };
    const boundPatch = material.files.find(({ path }) => path === 'patch/cordis.patch.yml');
    const patchBefore = Buffer.from(boundPatch?.contentBase64 ?? '', 'base64').toString();

    await writeFile(join(root, 'patch', 'cordis.patch.yml'), '- changed-after-plan\n');

    expect(patchBefore).toBe('[]\n');
    expect(Buffer.from(boundPatch?.contentBase64 ?? '', 'base64').toString()).toBe('[]\n');
    expect(material.lockDigest).toMatch(/^sha256-/u);
    expect(material.sourceFiles.map(({ path }) => path)).toEqual([
      'pack.lock.yml',
      'pack.yml',
      'patch/cordis.patch.yml',
    ]);
  });

  it('scans but excludes repository regular files from installation material', async () => {
    const root = await fixture();
    await mkdir(join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# repository documentation\n');
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n');

    const result = await readValidatedPack(root);

    expect(result.material).toBeDefined();
    expect(result.material?.paths).not.toContain('README.md');
    expect(result.material?.paths).not.toContain('.github/workflows/ci.yml');
    expect(result.material?.sourceFiles).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'README.md' }),
        expect.objectContaining({ path: '.github/workflows/ci.yml' }),
      ]),
    );
  });

  it('fails closed for a README secret while never echoing its synthetic token', async () => {
    const root = await fixture();
    const token = 'sk-README-READ-TESTONLY-012345678901234567890123';
    await writeFile(join(root, 'README.md'), `token: ${token}\n`);

    const result = await readValidatedPack(root);

    expect(result.exitCode).toBe(31);
    expect(result.material).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'E_SECRET_KEY' }));
    expect(JSON.stringify(result.diagnostics)).not.toContain(token.slice(0, 8));
  });

  it('does not scan ignored git credentials into the validation snapshot', async () => {
    const root = await fixture();
    const token = 'sk-GIT-READ-TESTONLY-012345678901234567890123456';
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'credential'), `token: ${token}\n`);

    const result = await readValidatedPack(root);

    expect(result.exitCode).toBe(30);
    expect(result.material).toBeDefined();
    expect(JSON.stringify(result.diagnostics)).not.toContain(token.slice(0, 8));
  });

  it('binds the complete lock document and ordered source file digests into planDigest', async () => {
    const root = await fixture();
    const first = await prepareInstallPlan(input(root));
    const lockPath = join(root, 'pack.lock.yml');
    const lock = parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    lock.generatedAt = '2026-08-16T01:02:03Z';
    await writeFile(lockPath, stringify(lock, { lineWidth: 0 }));
    const second = await prepareInstallPlan(input(root));

    expect(second.exitCode).toBe(0);
    expect(second.plan?.planDigest).not.toBe(first.plan?.planDigest);
    expect(second.plan).toMatchObject({
      lockDigest: expect.stringMatching(/^sha256-/u),
      sourceFiles: expect.arrayContaining([
        expect.objectContaining({
          path: 'pack.lock.yml',
          sha512: expect.stringMatching(/^sha512-/u),
        }),
        expect.objectContaining({ path: 'patch/cordis.patch.yml' }),
      ]),
    });
  });

  it('binds exact target before-state into stateDigest and exposes rollback snapshots', async () => {
    const root = await fixture({
      files: { 'skills/notes.md': '---\nname: notes\ndescription: x\n---\n' },
    });
    const base = input(root);
    const stateA = {
      profile: { path: 'profiles/research-pack', state: 'absent' as const },
      skills: [{ path: 'skills/notes', state: 'present' as const, sha256: 'sha256-user-a' }],
      presets: [],
      settings: { path: 'settings.yaml', state: 'present' as const, sha256: 'sha256-settings-a' },
    };
    const stateB = {
      ...stateA,
      settings: { ...stateA.settings, sha256: 'sha256-settings-b' },
    };
    const first = await prepareInstallPlan({
      ...base,
      environment: {
        ...base.environment,
        targetBeforeState: stateA,
        targetBeforeStateDigest: sha256(stateA),
      },
    });
    const second = await prepareInstallPlan({
      ...base,
      environment: {
        ...base.environment,
        targetBeforeState: stateB,
        targetBeforeStateDigest: sha256(stateB),
      },
    });

    expect(first.exitCode).toBe(0);
    expect(first.plan?.stateDigest).not.toBe(second.plan?.stateDigest);
    expect(first.plan).toMatchObject({
      beforeState: stateA,
      rollbackSnapshot: { enabled: true, targetBeforeStateDigest: sha256(stateA) },
      skills: [
        {
          id: 'notes',
          source: 'skills/notes.md',
          target: 'skills/notes',
          collision: true,
          action: 'skip',
          effectiveAt: '热生效',
        },
      ],
    });
  });

  it('emits canonical machine argv and PowerShell-safe command including --dsh-home', async () => {
    const root = await fixture({ manifest: manifest({ allowBuilds: true }) });
    const value = input(root);
    value.options = {
      ...value.options,
      sourceArgument: "C:/pack with space/it's-safe",
      yes: true,
      allowBuilds: ['example-bundle'],
    };
    const result = await prepareInstallPlan(value);

    expect(result.exitCode).toBe(0);
    expect(result.plan?.dshHome).toBe(value.environment.dshHome);
    expect(result.decision.nonInteractiveArgv).toEqual([
      'install',
      '--as',
      'research-pack',
      '--dsh-home',
      value.environment.dshHome,
      '--frozen',
      '--allow-build',
      'example-bundle',
      '--yes',
      '--',
      "C:/pack with space/it's-safe",
    ]);
    expect(result.decision.nonInteractiveCommand).toContain("'C:/pack with space/it''s-safe'");
    expect(result.decision.nonInteractiveCommand).toContain("--dsh-home '");
  });

  it.each(['--bad;Write-Output PWNED', '%PATH%', '$(Write-Output PWNED)', "quote'and space"])(
    'keeps flag-like or shell-active SOURCE as data: %s',
    async (sourceArgument) => {
      const root = await fixture();
      const value = input(root);
      value.options = { ...value.options, sourceArgument, yes: true };
      const result = await prepareInstallPlan(value);
      expect(result.exitCode).toBe(0);
      expect(result.decision.nonInteractiveArgv.slice(-2)).toEqual(['--', sourceArgument]);
      expect(result.decision.nonInteractiveCommand).toContain(
        `-- '${sourceArgument.replaceAll("'", "''")}'`,
      );
    },
  );

  it.each([
    [
      'source control',
      { sourceArgument: 'pack\nRemove-Item', as: 'research-pack' },
      31,
      'E_COMMAND_CONTROL',
    ],
    ['profile traversal', { sourceArgument: 'pack', as: '../escape' }, 31, 'E_PROFILE_PATH'],
    ['profile grammar', { sourceArgument: 'pack', as: 'foo..bar' }, 30, 'E_PROFILE_NAME'],
    ['profile contract', { sourceArgument: 'pack', as: 'BadName' }, 30, 'E_PROFILE_NAME'],
    [
      'default request without resolver seam',
      { sourceArgument: 'pack', frozen: false },
      20,
      'E_RESOLUTION_REQUIRED',
    ],
  ])('classifies %s with the narrow exit contract', async (_label, options, exitCode, code) => {
    const root = await fixture();
    const result = await prepareInstallPlan(input(root, { options: { ...options, yes: true } }));
    expect(result).toMatchObject({ exitCode });
    expect(result.diagnostics[0]).toMatchObject({ code });
  });

  it('rejects an unsupported pnpm and a tampered target-before-state digest before planning', async () => {
    const root = await fixture();
    const base = input(root);

    const unsupportedPnpm = await prepareInstallPlan({
      ...base,
      environment: { ...base.environment, pnpmVersion: '9.9.0' },
    });
    expect(unsupportedPnpm).toMatchObject({
      exitCode: 10,
      diagnostics: [expect.objectContaining({ code: 'E_PNPM_VERSION_UNSUPPORTED' })],
    });

    const tamperedState = await prepareInstallPlan({
      ...base,
      environment: { ...base.environment, targetBeforeStateDigest: 'sha256-tampered' },
    });
    expect(tamperedState).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_BEFORE_STATE_DIGEST' })],
    });
  });

  it('rejects a junction in a SOURCE ancestor before validator execution', async () => {
    const target = await fixture();
    const parent = await mkdtemp(join(target, '..', 'dshpack-junction-parent-'));
    const junction = join(parent, 'ancestor-link');
    const sourceThroughJunction = join(junction, basename(target));
    try {
      await symlink(dirname(target), junction, 'junction');
      let validated = false;
      const result = await readValidatedPack(sourceThroughJunction, {
        validate: async () => {
          validated = true;
          return {
            diagnostics: [],
            exitCode: 0,
            metadata: { source: sourceThroughJunction, valid: true },
          };
        },
      });
      expect(result).toMatchObject({ exitCode: 31 });
      expect(result.diagnostics[0]).toMatchObject({ code: 'E_SOURCE_SNAPSHOT_ENTRY' });
      expect(validated).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('classifies MCP credential diagnostics as security failures', () => {
    expect(
      validationExitCode([
        {
          code: 'E_MCP_CREDENTIAL',
          severity: 'error',
          message: 'credential',
          hint: 'remove',
          evidence: 'local',
        },
      ]),
    ).toBe(31);
  });

  it('validates settings aliases, preset YAML, and the default preset source during preflight', async () => {
    const settingsPack = manifest();
    settingsPack.settings = { namespaces: { 'agent-presets': 'agent-presets.yml' } };
    const alias = await prepareInstallPlan(
      input(
        await fixture({
          manifest: settingsPack,
          files: { 'settings/agent-presets.yml': 'shared: &shared\n  model: x\ncopy: *shared\n' },
        }),
      ),
    );
    expect(alias).toMatchObject({ exitCode: 30 });
    expect(alias.diagnostics[0]).toMatchObject({ code: 'E_SETTINGS_FRAGMENT_ALIAS' });

    const invalidPresetRoot = await fixture({
      files: { 'presets/custom/agent.cordis.yml': 'not: [valid' },
    });
    const invalidPresetBefore = targetBeforeState('research-pack', {
      presets: [{ path: '.agent-presets/custom', state: 'absent' }],
    });
    const invalidPreset = await prepareInstallPlan(
      input(invalidPresetRoot, {
        environment: {
          ...input(invalidPresetRoot).environment,
          targetBeforeState: invalidPresetBefore.state,
          targetBeforeStateDigest: invalidPresetBefore.digest,
        },
      }),
    );
    expect(invalidPreset).toMatchObject({ exitCode: 30 });
    expect(invalidPreset.diagnostics[0]).toMatchObject({ code: 'E_PRESET_YAML' });

    const defaultPack = manifest();
    defaultPack.defaults.agentPreset = 'missing';
    const missingDefault = await prepareInstallPlan(
      input(await fixture({ manifest: defaultPack })),
    );
    expect(missingDefault).toMatchObject({ exitCode: 30 });
    expect(missingDefault.diagnostics[0]).toMatchObject({ code: 'E_DEFAULT_PRESET_MISSING' });
  });

  it('structures MCP/default activation and keeps exact extra build approvals inert until audit', async () => {
    const pack = manifest();
    pack.defaults.agentPreset = 'custom';
    pack.mcp.push({
      serverName: 'docs',
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
    });
    const root = await fixture({
      manifest: pack,
      files: { 'presets/custom/agent.cordis.yml': '[]\n' },
    });
    const before = targetBeforeState('research-pack', {
      presets: [{ path: '.agent-presets/custom', state: 'absent' }],
    });
    const environment = {
      ...input(root).environment,
      targetBeforeState: before.state,
      targetBeforeStateDigest: before.digest,
    };
    const allowed = await prepareInstallPlan(
      input(root, {
        options: { sourceArgument: root, yes: true, allowBuilds: ['transitive-build'] },
        environment,
      }),
    );
    expect(allowed.exitCode).toBe(0);
    expect(allowed.plan).toMatchObject({
      extraBuildApprovals: ['transitive-build'],
      defaults: {
        agentPreset: { value: 'custom', source: 'pack', effectiveAt: '仅空白会话' },
        permissionPreset: { value: 'workspace-write', effectiveAt: '仅空白会话' },
      },
      mcp: [
        {
          serverName: 'docs',
          source: 'https://mcp.example.com',
          target: 'profile patch',
          action: 'configure',
          effectiveAt: '重启生效',
        },
      ],
    });

    const glob = await prepareInstallPlan(
      input(root, {
        options: { sourceArgument: root, yes: true, allowBuilds: ['transitive-*'] },
        environment,
      }),
    );
    expect(glob).toMatchObject({ exitCode: 30 });
    expect(glob.diagnostics[0]).toMatchObject({ code: 'E_ALLOW_BUILD_PATTERN' });
  });
});
