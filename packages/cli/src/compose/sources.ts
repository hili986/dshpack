import { randomBytes } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';

import type { Diagnostic } from '@dshpack/core';

import { materializeSource, SourceError } from '../adapters/source.js';
import { diagnostic } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { exportProfile } from '../export/engine.js';
import { skillsIn } from '../install/build-plan.js';
import { readValidatedPack, type ValidatedPackMaterial } from '../install/read.js';
import type { ComposeSelection, ComposeSourceItem } from './schema.js';

export interface ComposeMaterializedSource {
  cleanup: () => Promise<void>;
  from: string;
  license?: string;
  material: ValidatedPackMaterial;
}

export interface ComposeSourceDependencies {
  exportProfile?: typeof exportProfile;
  materialize?: typeof materializeSource;
  readPack?: typeof readValidatedPack;
}

export interface ComposeSourceFailure {
  diagnostics: readonly Diagnostic[];
  exitCode: ExitCode;
}

export type ComposeSourceResult = ComposeMaterializedSource | ComposeSourceFailure;

export function isComposeMaterializedSource(
  value: ComposeSourceResult,
): value is ComposeMaterializedSource {
  return 'material' in value;
}

function sourceFailure(code: string, message: string, hint: string, path?: string): Diagnostic {
  return diagnostic(code, 'error', message, hint, path);
}

function normalizeReference(reference: string, composeFile: string): string {
  const value = reference.startsWith('tarball:') ? reference.slice('tarball:'.length) : reference;
  return value.startsWith('./') ? resolve(dirname(composeFile), value) : value;
}

async function validated(
  root: string,
  from: string,
  cleanup: () => Promise<void>,
  readPack: typeof readValidatedPack,
): Promise<ComposeSourceResult> {
  const source = await readPack(root, { frozen: false });
  if (source.material === undefined) {
    await cleanup();
    return { diagnostics: source.diagnostics, exitCode: source.exitCode };
  }
  return {
    cleanup,
    from,
    license: source.material.manifest.license,
    material: source.material,
  };
}

async function materializeProfile(
  selection: ComposeSelection,
  composeFile: string,
  dshHome: string | undefined,
  dependencies: ComposeSourceDependencies,
): Promise<ComposeSourceResult> {
  if (dshHome === undefined) {
    return {
      diagnostics: [
        sourceFailure(
          'E_DSH_HOME_REQUIRED',
          'profile: source 需要显式隔离的 DSH_HOME。',
          '使用 --dsh-home 指向绝对路径。',
          selection.from,
        ),
      ],
      exitCode: EXIT_CODES.ENVIRONMENT,
    };
  }
  const profile = selection.from.slice('profile:'.length);
  const output = join(
    dirname(composeFile),
    `.dshpack-compose-profile-${randomBytes(8).toString('hex')}`,
  );
  const report = await (dependencies.exportProfile ?? exportProfile)({
    dshHome,
    output,
    profile,
    includeSkills: true,
    yes: true,
  });
  if (report.exitCode !== 0) return { diagnostics: report.diagnostics, exitCode: report.exitCode };
  const cleanup = async () => {
    const { rm } = await import('node:fs/promises');
    await rm(output, { recursive: true, force: true });
  };
  return validated(output, selection.from, cleanup, dependencies.readPack ?? readValidatedPack);
}

/** Materialize every source through the established source/export and immutable snapshot paths. */
export async function materializeComposeSource(
  selection: ComposeSelection,
  composeFile: string,
  dshHome: string | undefined,
  dependencies: ComposeSourceDependencies = {},
): Promise<ComposeSourceResult> {
  if (selection.from.startsWith('profile:'))
    return materializeProfile(selection, composeFile, dshHome, dependencies);
  try {
    const materialized = await (dependencies.materialize ?? materializeSource)(
      normalizeReference(selection.from, composeFile),
    );
    return validated(
      materialized.directory,
      selection.from,
      materialized.cleanup,
      dependencies.readPack ?? readValidatedPack,
    );
  } catch (error) {
    return {
      diagnostics: [
        sourceFailure(
          error instanceof SourceError ? error.code : 'E_COMPOSE_SOURCE',
          error instanceof Error ? error.message : 'source 获取失败。',
          '检查 source 安全约束后重试。',
          selection.from,
        ),
      ],
      exitCode: error instanceof SourceError ? error.exitCode : EXIT_CODES.CONTRACT,
    };
  }
}

function posix(value: string): string {
  return value.split(sep).join('/');
}

function pathForSkill(path: string, source: string): string | undefined {
  if (path === source) return '';
  return path.startsWith(`${source}/`) ? path.slice(source.length + 1) : undefined;
}

export function sourceSkills(
  source: ComposeMaterializedSource,
  selection: ComposeSelection,
): { available: string[]; items: ComposeSourceItem[] } {
  const skills = skillsIn(source.material.paths);
  const available = skills
    .map(({ id }) => id)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const chosen = selection.skills.includes('*') ? available : selection.skills;
  const items: ComposeSourceItem[] = [];
  for (const id of chosen) {
    const skill = skills.find((candidate) => candidate.id === id);
    if (skill === undefined) continue;
    for (const file of source.material.files) {
      const sourcePath = pathForSkill(file.path, skill.source);
      if (sourcePath === undefined) continue;
      items.push({
        bytes: Buffer.from(file.contentBase64, 'base64'),
        from: source.from,
        id,
        ...(source.license === undefined ? {} : { license: source.license }),
        originalPath: posix(file.path),
        sourcePath,
      });
    }
  }
  return { available, items };
}

export function missingSkillDiagnostics(
  source: ComposeMaterializedSource,
  selection: ComposeSelection,
  available: readonly string[],
): Diagnostic[] {
  if (selection.skills.includes('*')) return [];
  return selection.skills
    .filter((id) => !available.includes(id))
    .map((id) =>
      sourceFailure(
        'E_COMPOSE_SKILL_MISSING',
        `source ${source.from} 中不存在 skill ${id}。`,
        `可选 id: ${available.join(', ') || '(none)'}`,
        `${source.from}:${id}`,
      ),
    );
}
