import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { confirm } from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ValidatedPackMaterial } from '../src/install/read.js';
import { createNodeInstallRuntime } from '../src/install/runtime.js';
import {
  authorizeWorkspaceBuild,
  writeMaterialAssetSnapshot,
} from '../src/install/runtime-assets.js';
import { createPathProcessRuntime } from '../src/install/runtime-process.js';
import { captureInstallTargetState } from '../src/install/runtime-state.js';

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, confirm: vi.fn(async () => false) };
});

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-install-runtime-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.mocked(confirm).mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('install PATH-only process runtime', () => {
  it('renders the default-refuse prompt on stderr', async () => {
    const runtime = createNodeInstallRuntime(await temporary(), {
      process: createPathProcessRuntime({
        spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      }),
    });
    await expect(
      runtime.confirm({ kind: 'install', subject: 'demo', defaultValue: false }),
    ).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: false, output: process.stderr }),
    );
  });

  it('probes and runs only PATH dsh/pnpm with direct-child termination disabled', async () => {
    const calls: {
      command: string;
      args: readonly string[];
      killDescendants: false;
      dshHome: string;
    }[] = [];
    const process = createPathProcessRuntime({
      spawn: async (command, args, options) => {
        calls.push({
          command,
          args,
          killDescendants: options.killDescendants,
          dshHome: options.env.DSH_HOME as string,
        });
        return {
          exitCode: 0,
          stdout: args.includes('--version')
            ? command === 'dsh'
              ? '0.1.0-rc.6\n'
              : '11.7.0\n'
            : 'ok\n',
          stderr: '',
        };
      },
    });
    const dshHome = await temporary();

    await expect(process.probe(dshHome)).resolves.toEqual({
      dshVersion: '0.1.0-rc.6',
      pnpmVersion: '11.7.0',
    });
    await process.runDsh(['--profile', 'demo', '--dump-config'], { dshHome });
    await process.runPnpm(['rebuild', 'exact-package'], { dshHome, cwd: dshHome });

    expect(calls.map(({ command }) => command)).toEqual(['dsh', 'pnpm', 'dsh', 'pnpm']);
    expect(calls.some(({ command }) => command === 'npx')).toBe(false);
    expect(calls.every(({ killDescendants }) => killDescendants === false)).toBe(true);
    expect(calls.every((call) => call.dshHome === dshHome)).toBe(true);
    await expect(access(join(dshHome, '.dshpack', 'logs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed on missing PATH command or malformed version without npx fallback', async () => {
    const commands: string[] = [];
    const missing = createPathProcessRuntime({
      spawn: async (command) => {
        commands.push(command);
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    });
    await expect(missing.probe(await temporary())).rejects.toMatchObject({
      code: 'E_PATH_PROCESS',
    });
    expect(commands).toEqual(['dsh']);

    const malformed = createPathProcessRuntime({
      spawn: async (command) => ({
        exitCode: 0,
        stdout: command === 'dsh' ? 'not-semver\n' : '11.7.0\n',
        stderr: '',
      }),
    });
    await expect(malformed.probe(await temporary())).rejects.toMatchObject({
      code: 'E_PATH_VERSION',
    });
  });

  it.each([7, null] as const)(
    'preserves a nonzero or missing subprocess exit %s',
    async (exitCode) => {
      const process = createPathProcessRuntime({
        env: { INSTALL_RUNTIME_SENTINEL: 'bound' },
        spawn: async (_command, _args, options) => {
          expect(options.env.INSTALL_RUNTIME_SENTINEL).toBe('bound');
          return { exitCode, stdout: '', stderr: 'failed' };
        },
      });
      await expect(process.runDsh([], { dshHome: await temporary() })).rejects.toMatchObject({
        code: 'E_PATH_PROCESS',
        exitCode: exitCode ?? 1,
      });
    },
  );

  it('removes inherited lifecycle escalation keys and toggles scripts only for rebuild', async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const process = createPathProcessRuntime({
      env: {
        NPM_CONFIG_IGNORE_SCRIPTS: 'false',
        npm_config_DANGEROUSLY_ALLOW_ALL_BUILDS: 'true',
        PnPm_CoNfIg_OnLy_BuIlT_DePeNdEnCiEs: '*',
        NpM_CoNfIg_AlLoW_BuIlDs: '*',
      },
      spawn: async (_command, _args, options) => {
        environments.push(options.env);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const dshHome = await temporary();
    await process.runDsh(['plugin', 'add', 'exact-package@1.0.0'], {
      dshHome,
      scriptPolicy: 'deny',
    } as never);
    await process.runPnpm(['rebuild', 'exact-package'], {
      dshHome,
      cwd: dshHome,
      scriptPolicy: 'allow-approved',
    } as never);

    const normalized = environments.map((environment) =>
      Object.fromEntries(
        Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]),
      ),
    );
    expect(normalized[0]).toMatchObject({ npm_config_ignore_scripts: 'true' });
    expect(normalized[1]).toMatchObject({ npm_config_ignore_scripts: 'false' });
    for (const environment of normalized) {
      expect(environment).not.toHaveProperty('npm_config_dangerously_allow_all_builds');
      expect(environment).not.toHaveProperty('pnpm_config_only_built_dependencies');
      expect(environment).not.toHaveProperty('npm_config_allow_builds');
    }
  });

  it('isolates resolver pnpm from every inherited npm and pnpm configuration key', async () => {
    let resolverEnvironment: NodeJS.ProcessEnv | undefined;
    const process = createPathProcessRuntime({
      env: {
        PATH: 'resolver-path-only',
        PNPM_CONFIG_LOCKFILE_DIR: 'C:\\escape-lock',
        pNpM_cOnFiG_gLoBaL: 'true',
        NPM_CONFIG_PNPMFILE: 'C:\\escape-hook.cjs',
        npm_config_registry: 'https://credentials.invalid/',
        PnPm_CoNfIg_ViRtUaL_StOrE_DiR: 'C:\\escape-store',
        npm_config_userconfig: 'C:\\escape-npmrc',
      },
      spawn: async (_command, _args, options) => {
        resolverEnvironment = options.env;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const dshHome = await temporary();

    await process.runPnpm(['add', '--lockfile-only'], {
      dshHome,
      cwd: dshHome,
      scriptPolicy: 'deny',
      environmentPolicy: 'resolution-isolated',
    } as never);

    const normalized = Object.fromEntries(
      Object.entries(resolverEnvironment ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    expect(normalized).toMatchObject({
      path: 'resolver-path-only',
      dsh_home: dshHome,
      npm_config_ignore_scripts: 'true',
      xdg_config_home: join(dshHome, 'config'),
    });
    expect(
      Object.keys(normalized).filter(
        (key) =>
          (key.startsWith('npm_config_') || key.startsWith('pnpm_config_')) &&
          key !== 'npm_config_ignore_scripts',
      ),
    ).toEqual([]);
  });

  it('confines migration scratch subprocesses to an allowlisted environment and private paths', async () => {
    const scratchEnvironments: NodeJS.ProcessEnv[] = [];
    const process = createPathProcessRuntime({
      env: {
        PATH: 'scratch-path-only',
        SYSTEMROOT: 'C:\\Windows',
        API_TOKEN: 'must-not-leak',
        GH_TOKEN: 'must-not-leak',
        NPM_TOKEN: 'must-not-leak',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak',
        npm_config_registry: 'https://credential.example.invalid/',
      },
      spawn: async (_command, _args, options) => {
        scratchEnvironments.push(options.env);
        return { exitCode: 0, stdout: '1.2.3', stderr: '' };
      },
    });
    const scratch = await temporary();

    await process.runPnpm(['add', '--ignore-scripts'], {
      dshHome: scratch,
      cwd: scratch,
      environmentPolicy: 'migration-scratch' as never,
      scriptPolicy: 'deny',
    });

    await process.runDsh(['--version'], {
      dshHome: scratch,
      environmentPolicy: 'migration-scratch' as never,
      scriptPolicy: 'deny',
    });
    await process.probe(scratch, 'migration-scratch' as never);

    expect(scratchEnvironments).toHaveLength(4);
    for (const environment of scratchEnvironments) {
      const normalized = Object.fromEntries(
        Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]),
      );
      expect(normalized).toMatchObject({
        path: 'scratch-path-only',
        dsh_home: scratch,
        npm_config_ignore_scripts: 'true',
        xdg_config_home: join(scratch, '.dshpack', 'migration-runtime', 'config'),
        xdg_cache_home: join(scratch, '.dshpack', 'migration-runtime', 'cache'),
        temp: join(scratch, '.dshpack', 'migration-runtime', 'tmp'),
        tmp: join(scratch, '.dshpack', 'migration-runtime', 'tmp'),
        npm_config_userconfig: join(scratch, '.dshpack', 'migration-runtime', 'npmrc'),
        npm_config_cache: join(scratch, '.dshpack', 'migration-runtime', 'cache'),
        pnpm_home: join(scratch, '.dshpack', 'migration-runtime', 'pnpm-home'),
      });
      for (const name of [
        'api_token',
        'gh_token',
        'npm_token',
        'aws_secret_access_key',
        'npm_config_registry',
      ])
        expect(normalized).not.toHaveProperty(name);
    }
  });

  it('keeps a PATH-first lifecycle sentinel off during add and enables it only for approved rebuild', async () => {
    const root = await temporary();
    const shim = join(root, 'shim');
    const sentinel = join(root, 'lifecycle-executed.txt');
    await mkdir(shim);
    const command = [
      '@echo off',
      'if /I not "%npm_config_ignore_scripts%"=="true" echo executed>"%INSTALL_SENTINEL%"',
      'exit /b 0',
      '',
    ].join('\r\n');
    await writeFile(join(shim, 'dsh.cmd'), command);
    await writeFile(join(shim, 'pnpm.cmd'), command);
    const posix = [
      '#!/bin/sh',
      'if [ "$npm_config_ignore_scripts" != "true" ]; then printf executed > "$INSTALL_SENTINEL"; fi',
      'exit 0',
      '',
    ].join('\n');
    for (const executable of ['dsh', 'pnpm']) {
      const path = join(shim, executable);
      await writeFile(path, posix);
      await chmod(path, 0o700);
    }
    const process = createPathProcessRuntime({
      env: {
        PATH: shim,
        INSTALL_SENTINEL: sentinel,
        NpM_CoNfIg_AlLoW_BuIlDs: '*',
        PnPm_CoNfIg_DaNgErOuSlY_AlLoW_AlL_BuIlDs: 'true',
      },
    });

    await process.runDsh(['plugin', 'add', 'exact-package@1.0.0'], {
      dshHome: root,
      scriptPolicy: 'deny',
    });
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    await process.runPnpm(['rebuild', 'exact-package'], {
      dshHome: root,
      cwd: root,
      scriptPolicy: 'allow-approved',
    });
    await expect(readFile(sentinel, 'utf8')).resolves.toContain('executed');
  });
});

function material(files: Record<string, string>): ValidatedPackMaterial {
  return {
    manifest: {} as ValidatedPackMaterial['manifest'],
    manifestDigest: 'sha256-fixture-manifest',
    paths: Object.keys(files),
    sourceFiles: [],
    files: Object.entries(files).map(([path, contents]) => ({
      path,
      contentBase64: Buffer.from(contents).toString('base64'),
      sha512: 'sha512-fixture',
    })),
  };
}

describe('install target state and material assets', () => {
  it('binds the complete before-state including external preset and settings bytes', async () => {
    const dshHome = await temporary();
    const request = {
      dshHome,
      profile: 'demo',
      skills: ['skills/notes'],
      presets: ['.agent-presets/custom'],
      externalDefaultPreset: '.agent-presets/external',
    };
    const empty = await captureInstallTargetState(request);
    expect(empty.state).toMatchObject({
      profile: { path: 'profiles/demo', state: 'absent' },
      skills: [{ path: 'skills/notes', state: 'absent' }],
      presets: [{ path: '.agent-presets/custom', state: 'absent' }],
      settings: { path: 'settings.yaml', state: 'absent' },
      externalDefaultPreset: { path: '.agent-presets/external', state: 'absent' },
    });

    for (const path of [
      'profiles/demo',
      'skills/notes',
      '.agent-presets/custom',
      '.agent-presets/external',
    ]) {
      await mkdir(join(dshHome, ...path.split('/')), { recursive: true });
      await writeFile(join(dshHome, ...path.split('/'), 'fact'), path);
    }
    const settings = '# exact bytes\nagent-presets: {}\n';
    await writeFile(join(dshHome, 'settings.yaml'), settings);
    const present = await captureInstallTargetState(request);
    expect(present.settingsDocument).toBe(settings);
    expect(present.state.profile.state).toBe('present');
    expect(present.state.externalDefaultPreset?.state).toBe('present');
    expect(present.digest).not.toBe(empty.digest);

    await writeFile(join(dshHome, 'profiles', 'demo', 'fact'), 'mutated bytes');
    expect((await captureInstallTargetState(request)).digest).not.toBe(present.digest);
  });

  it('rejects a junction target instead of hashing outside DSH_HOME', async () => {
    const dshHome = await temporary();
    const external = await temporary();
    await mkdir(join(dshHome, 'skills'));
    await symlink(external, join(dshHome, 'skills', 'notes'), 'junction');
    await expect(
      captureInstallTargetState({
        dshHome,
        profile: 'demo',
        skills: ['skills/notes'],
        presets: [],
      }),
    ).rejects.toMatchObject({ code: 'E_TARGET_PATH' });
  });

  it('writes only immutable material bytes and performs exact workspace authorization', async () => {
    const root = await temporary();
    const skill = join(root, 'skill');
    const preset = join(root, 'preset');
    await mkdir(skill);
    await mkdir(preset);
    const snapshot = material({
      'skills/notes.md': '# immutable skill\n',
      'presets/custom/agent.cordis.yml': '[]\n',
      'presets/custom/readme.md': 'preset bytes\n',
    });
    await writeMaterialAssetSnapshot(snapshot, 'skills/notes.md', skill, 'skill');
    await writeMaterialAssetSnapshot(snapshot, 'presets/custom', preset, 'preset');
    expect(await readFile(join(skill, 'SKILL.md'), 'utf8')).toBe('# immutable skill\n');
    expect(await readFile(join(preset, 'agent.cordis.yml'), 'utf8')).toBe('[]\n');
    await expect(
      writeMaterialAssetSnapshot(snapshot, 'skills/missing.md', skill, 'skill'),
    ).rejects.toMatchObject({ code: 'E_ASSET_SOURCE' });
    const legacy = join(root, 'legacy-preset');
    await mkdir(legacy);
    await writeMaterialAssetSnapshot(
      material({ 'presets/legacy.md': 'legacy bytes\n' }),
      'presets/legacy.md',
      legacy,
      'preset',
    );
    expect(await readFile(join(legacy, 'legacy.md'), 'utf8')).toBe('legacy bytes\n');
    await expect(
      writeMaterialAssetSnapshot(
        material({ 'skills/tree/../escape': 'unsafe' }),
        'skills/tree',
        join(root, 'unsafe'),
        'skill',
      ),
    ).rejects.toMatchObject({ code: 'E_ASSET_PATH' });

    const profile = join(root, 'profile');
    await mkdir(profile);
    const workspace = join(profile, 'pnpm-workspace.yaml');
    await writeFile(workspace, '# keep\npackages: [.]\n');
    await authorizeWorkspaceBuild(profile, '@scope/transitive');
    const allowed = await readFile(workspace, 'utf8');
    expect(allowed).toContain('# keep');
    expect(allowed).toContain('"@scope/transitive": true');
    await authorizeWorkspaceBuild(profile, '@scope/transitive');
    await expect(authorizeWorkspaceBuild(profile, '*')).rejects.toMatchObject({
      code: 'E_WORKSPACE_BUILD_KEY',
    });
    expect(await readFile(workspace, 'utf8')).toBe(allowed);
  });
});
