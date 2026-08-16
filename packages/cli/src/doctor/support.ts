import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Diagnostic } from '@dshpack/core';

import type { runDsh } from '../adapters/process.js';
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
  sideEffects: readonly ['profile/cordis.yml'];
}

export interface ProfileFacts {
  bundles: string[];
  dependencies: Record<string, string>;
  patch: string;
  root: string;
}

export const sideEffects = ['profile/cordis.yml'] as const;

export function dshOptions(input: DoctorInput): Pick<Parameters<typeof runDsh>[1], 'env'> {
  return input.env === undefined ? {} : { env: input.env };
}

export function versionAtLeast(value: string, minimum: readonly number[]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return parts.some((part, index) => part !== minimum[index] && part > (minimum[index] ?? 0));
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
