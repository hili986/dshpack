import { execa } from 'execa';

import type { InstallSubprocessResult } from './runtime-types.js';

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
  probe(dshHome: string): Promise<{ dshVersion: string; pnpmVersion: string }>;
  runDsh(
    args: readonly string[],
    options: { dshHome: string; cwd?: string },
  ): Promise<InstallSubprocessResult>;
  runPnpm(
    args: readonly string[],
    options: { dshHome: string; cwd: string },
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
  const result = await execa(command, [...args], options);
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
  const run = async (
    command: 'dsh' | 'pnpm',
    args: readonly string[],
    dshHome: string,
    cwd: string,
    timeout: number,
  ): Promise<InstallSubprocessResult> => {
    let result: Awaited<ReturnType<PathSpawn>>;
    try {
      result = await spawn(command, args, {
        cwd,
        env: { ...process.env, ...dependencies.env, DSH_HOME: dshHome },
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
    async probe(dshHome) {
      const dsh = await run('dsh', ['--version'], dshHome, dshHome, 5_000);
      const pnpm = await run('pnpm', ['--version'], dshHome, dshHome, 5_000);
      return {
        dshVersion: cleanVersion('dsh', dsh.stdout),
        pnpmVersion: cleanVersion('pnpm', pnpm.stdout),
      };
    },
    runDsh: (args, options) =>
      run('dsh', args, options.dshHome, options.cwd ?? options.dshHome, 30_000),
    runPnpm: (args, options) => run('pnpm', args, options.dshHome, options.cwd, 30_000),
  };
}
