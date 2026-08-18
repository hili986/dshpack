import { join } from 'node:path';

import { execa } from 'execa';

import type {
  InstallSubprocessResult,
  LifecycleScriptPolicy,
  ProcessEnvironmentPolicy,
} from './runtime-types.js';

export interface PathSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv & { DSH_HOME: string };
  killDescendants: false;
  reject: false;
  shell: false;
  timeout: number;
  windowsHide: true;
}

export type PathSpawn = (
  command: 'dsh' | 'pnpm',
  args: readonly string[],
  options: PathSpawnOptions,
) => Promise<{ exitCode: number | null | undefined; stdout: string; stderr: string }>;

export interface PathProcessRuntime {
  probe(
    dshHome: string,
    environmentPolicy?: ProcessEnvironmentPolicy,
  ): Promise<{ dshVersion: string; pnpmVersion: string }>;
  runDsh(
    args: readonly string[],
    options: {
      dshHome: string;
      cwd?: string;
      environmentPolicy?: ProcessEnvironmentPolicy;
      scriptPolicy?: LifecycleScriptPolicy;
    },
  ): Promise<InstallSubprocessResult>;
  runPnpm(
    args: readonly string[],
    options: {
      dshHome: string;
      cwd: string;
      environmentPolicy?: ProcessEnvironmentPolicy;
      scriptPolicy?: LifecycleScriptPolicy;
    },
  ): Promise<InstallSubprocessResult>;
}

export class InstallPathProcessError extends Error {
  readonly code = 'E_PATH_PROCESS';

  constructor(
    readonly command: 'dsh' | 'pnpm',
    readonly exitCode: number,
  ) {
    super(`${command} PATH subprocess failed with exit ${exitCode}.`);
    this.name = 'InstallPathProcessError';
  }
}

class InstallPathVersionError extends Error {
  readonly code = 'E_PATH_VERSION';

  constructor(command: 'dsh' | 'pnpm') {
    super(`${command} --version did not return SemVer.`);
    this.name = 'InstallPathVersionError';
  }
}

const defaultSpawn: PathSpawn = async (command, args, options) => {
  // npm packages on Windows provide both a POSIX no-extension shim and a .cmd shim.
  // With shell:false, spawning the former can fail before Node considers PATHEXT, so choose
  // the command shim explicitly while preserving argv-based, direct-child execution.
  const executable = process.platform === 'win32' ? `${command}.cmd` : command;
  const result = await execa(executable, [...args], options);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

function cleanVersion(command: 'dsh' | 'pnpm', value: string): string {
  const version = value.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version))
    throw new InstallPathVersionError(command);
  return version;
}

export function createPathProcessRuntime(
  dependencies: { spawn?: PathSpawn; env?: Readonly<NodeJS.ProcessEnv> } = {},
): PathProcessRuntime {
  const spawn = dependencies.spawn ?? defaultSpawn;
  const environment = (
    dshHome: string,
    cwd: string,
    scriptPolicy: LifecycleScriptPolicy,
    environmentPolicy: ProcessEnvironmentPolicy,
  ): NodeJS.ProcessEnv & { DSH_HOME: string } => {
    const merged = { ...process.env, ...dependencies.env };
    if (environmentPolicy === 'migration-scratch') {
      const allowlisted = new Set([
        'PATH',
        'PATHEXT',
        'COMSPEC',
        'SYSTEMROOT',
        'WINDIR',
        'OS',
        'PROCESSOR_ARCHITECTURE',
        'PROCESSOR_IDENTIFIER',
        'NUMBER_OF_PROCESSORS',
      ]);
      const inherited = Object.fromEntries(
        Object.entries(merged).filter(([key]) => allowlisted.has(key.toUpperCase())),
      );
      const privateRoot = join(dshHome, '.dshpack', 'migration-runtime');
      return {
        ...inherited,
        DSH_HOME: dshHome,
        XDG_CONFIG_HOME: join(privateRoot, 'config'),
        XDG_CACHE_HOME: join(privateRoot, 'cache'),
        TEMP: join(privateRoot, 'tmp'),
        TMP: join(privateRoot, 'tmp'),
        npm_config_ignore_scripts: 'true',
        npm_config_userconfig: join(privateRoot, 'npmrc'),
        npm_config_cache: join(privateRoot, 'cache'),
        npm_config_store_dir: join(privateRoot, 'store'),
        pnpm_config_store_dir: join(privateRoot, 'store'),
        pnpm_config_cache_dir: join(privateRoot, 'cache'),
        PNPM_HOME: join(privateRoot, 'pnpm-home'),
      };
    }
    const sanitized = Object.fromEntries(
      Object.entries(merged).filter(([key]) => {
        const normalized = key.toLowerCase();
        const prefix = normalized.startsWith('npm_config_')
          ? 'npm_config_'
          : normalized.startsWith('pnpm_config_')
            ? 'pnpm_config_'
            : undefined;
        if (prefix === undefined) return true;
        if (environmentPolicy === 'resolution-isolated') return false;
        const setting = normalized.slice(prefix.length).replaceAll('_', '');
        return ![
          'ignorescripts',
          'dangerouslyallowallbuilds',
          'onlybuiltdependencies',
          'allowbuilds',
        ].includes(setting);
      }),
    );
    const isolated =
      environmentPolicy === 'resolution-isolated' ? { XDG_CONFIG_HOME: join(cwd, 'config') } : {};
    return {
      ...sanitized,
      ...isolated,
      DSH_HOME: dshHome,
      npm_config_ignore_scripts: scriptPolicy === 'allow-approved' ? 'false' : 'true',
    };
  };
  const run = async (
    command: 'dsh' | 'pnpm',
    args: readonly string[],
    dshHome: string,
    cwd: string,
    timeout: number,
    scriptPolicy: LifecycleScriptPolicy,
    environmentPolicy: ProcessEnvironmentPolicy,
  ): Promise<InstallSubprocessResult> => {
    let result: Awaited<ReturnType<PathSpawn>>;
    try {
      result = await spawn(command, args, {
        cwd,
        env: environment(dshHome, cwd, scriptPolicy, environmentPolicy),
        killDescendants: false,
        reject: false,
        shell: false,
        timeout,
        windowsHide: true,
      });
    } catch {
      throw new InstallPathProcessError(command, 1);
    }
    if (result.exitCode !== 0) throw new InstallPathProcessError(command, result.exitCode ?? 1);
    return { stdout: result.stdout, stderr: result.stderr };
  };
  return {
    async probe(dshHome, environmentPolicy: ProcessEnvironmentPolicy = 'inherited-safe') {
      // A first-use DSH_HOME intentionally does not exist yet. It belongs in the child
      // environment, but cannot be the process cwd because spawn rejects a missing cwd before
      // either dsh.cmd or pnpm.cmd gets a chance to initialize it.
      const probeCwd = process.cwd();
      const dsh = await run(
        'dsh',
        ['--version'],
        dshHome,
        probeCwd,
        5_000,
        'deny',
        environmentPolicy,
      );
      const pnpm = await run(
        'pnpm',
        ['--version'],
        dshHome,
        probeCwd,
        5_000,
        'deny',
        environmentPolicy,
      );
      return {
        dshVersion: cleanVersion('dsh', dsh.stdout),
        pnpmVersion: cleanVersion('pnpm', pnpm.stdout),
      };
    },
    runDsh: (args, options) =>
      run(
        'dsh',
        args,
        options.dshHome,
        options.cwd ?? options.dshHome,
        30_000,
        options.scriptPolicy ?? 'deny',
        options.environmentPolicy ?? 'inherited-safe',
      ),
    runPnpm: (args, options) =>
      run(
        'pnpm',
        args,
        options.dshHome,
        options.cwd,
        30_000,
        options.scriptPolicy ?? 'deny',
        options.environmentPolicy ?? 'inherited-safe',
      ),
  };
}
