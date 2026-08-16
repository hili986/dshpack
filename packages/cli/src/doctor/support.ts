import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { type Diagnostic, scanSecrets } from '@dshpack/core';

import type { DshProcessResult, RunDshOptions, runDsh } from '../adapters/process.js';
import { diagnostic } from '../commands/shared.js';

export interface DoctorInput {
  dshHome: string;
  profile?: string;
  strict?: boolean;
  fix?: boolean;
  nodeVersion?: string;
  yes?: boolean;
  env?: Readonly<NodeJS.ProcessEnv>;
}

export interface DoctorMetadata {
  profile?: string;
  sideEffects: readonly DoctorSideEffect[];
}

export interface DoctorSideEffect {
  owner: 'dsh' | 'dshpack';
  path: string;
}

export type DoctorDshRunner = (
  args: readonly string[],
  options: RunDshOptions,
) => Promise<Pick<DshProcessResult, 'stdout'>>;

export interface DoctorDependencies {
  runDsh?: DoctorDshRunner;
}

export interface ProfileFacts {
  bundles: string[];
  dependencies: Record<string, string>;
  patch: string;
  root: string;
}

/** Side effects are reported with ownership so callers cannot mistake dshpack audit logs for dsh writes. */
export const sideEffects: readonly DoctorSideEffect[] = [
  { owner: 'dsh', path: 'profile/cordis.yml' },
  { owner: 'dshpack', path: '.dshpack/logs/<file>' },
];

export function dshOptions(input: DoctorInput): Pick<Parameters<typeof runDsh>[1], 'env'> {
  return input.env === undefined ? {} : { env: input.env };
}

export function versionAtLeast(value: string, minimum: readonly number[]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (const [index, part] of parts.entries()) {
    const minimumPart = minimum[index] ?? 0;
    if (part > minimumPart) return true;
    if (part < minimumPart) return false;
  }
  return true;
}

export function profileDiagnostic(
  id: string,
  message: string,
  hint: string,
  path?: string,
): Diagnostic {
  return diagnostic(id, 'error', message, hint, path);
}

export async function text(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readProfile(
  dshHome: string,
  profile: string,
): Promise<{ facts?: ProfileFacts; diagnostics: Diagnostic[] }> {
  const root = join(dshHome, 'profiles', profile);
  const manifestText = await text(join(root, 'package.json'));
  const patch = await text(join(root, 'cordis.patch.yml'));
  if (manifestText === undefined || patch === undefined) {
    return {
      diagnostics: [
        profileDiagnostic(
          'DSH004',
          'profile 缺少 package.json 或 cordis.patch.yml。',
          '先用 dsh 初始化该 profile。',
          root,
        ),
      ],
    };
  }
  try {
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const dependencies =
      typeof manifest.dependencies === 'object' &&
      manifest.dependencies !== null &&
      !Array.isArray(manifest.dependencies)
        ? (manifest.dependencies as Record<string, string>)
        : undefined;
    const dsh = manifest.dsh as Record<string, unknown> | undefined;
    const profileData = dsh?.profile as Record<string, unknown> | undefined;
    const bundles = profileData?.bundles;
    if (
      dependencies === undefined ||
      !Array.isArray(bundles) ||
      !bundles.every((value) => typeof value === 'string')
    ) {
      return {
        diagnostics: [
          profileDiagnostic(
            'DSH004',
            'profile manifest 的 dependencies 或 dsh.profile.bundles 不合法。',
            '修复 package.json 的 profile manifest。',
            join(root, 'package.json'),
          ),
        ],
      };
    }
    if (new Set(bundles).size !== bundles.length) {
      return {
        diagnostics: [
          profileDiagnostic(
            'DSH004',
            'profile bundles 存在重复项。',
            '每个 bundle 只保留一次。',
            join(root, 'package.json'),
          ),
        ],
      };
    }
    return { facts: { bundles: [...bundles], dependencies, patch, root }, diagnostics: [] };
  } catch {
    return {
      diagnostics: [
        profileDiagnostic(
          'DSH004',
          'profile package.json 不能解析。',
          '修复 JSON 语法。',
          join(root, 'package.json'),
        ),
      ],
    };
  }
}

export async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { encoding: 'utf8', withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile() && (entry.name === 'SKILL.md' || path.endsWith('.md'))) output.push(path);
    }
  };
  await visit(root);
  return output;
}

/** Scan only profile-owned source files; dependencies and their lockfile are not profile payload. */
export async function profileSecretDiagnostics(root: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { encoding: 'utf8', withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      diagnostics.push(
        profileDiagnostic(
          'DSH014',
          '无法完整扫描 profile 中的凭据泄漏。',
          '检查 profile 文件权限后重试。',
          directory,
        ),
      );
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'pnpm-lock.yaml') continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      diagnostics.push(...scanSecrets({ path }));
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(absolute);
      if (entry.isFile()) {
        const content = await text(absolute);
        if (content !== undefined) diagnostics.push(...scanSecrets({ path, content }));
      }
    }
  };
  await visit(root);
  return diagnostics;
}
