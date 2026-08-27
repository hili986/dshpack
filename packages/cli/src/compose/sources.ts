import { createHash, randomBytes } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { type Diagnostic, inspectSkill, scanSecrets } from '@dshpack/core';

import {
  materializeSource,
  SourceError,
  sourceReferenceFromProvenance,
} from '../adapters/source.js';
import { diagnostic, exitCodeFor } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { exportProfile } from '../export/engine.js';
import { skillsIn } from '../install/build-plan.js';
import { readValidatedPack, type ValidatedPackMaterial } from '../install/read.js';
import {
  captureSourceDirectory,
  readBoundedRegularFile,
  SnapshotCaptureError,
} from '../install/snapshot-capture.js';
import type { ComposeSelection, ComposeSourceItem } from './schema.js';

export interface ComposeMaterializedSource {
  cleanup: () => Promise<void>;
  diagnostics?: readonly Diagnostic[];
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

const CONVENTIONAL_SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface ConventionalSkillSource {
  diagnostics: readonly Diagnostic[];
  license: string;
  material: ValidatedPackMaterial;
}

function digest(algorithm: 'sha256' | 'sha512', value: Uint8Array): string {
  return `${algorithm}-${createHash(algorithm)
    .update(value)
    .digest(algorithm === 'sha256' ? 'base64url' : 'base64')}`;
}

async function conventionalLicense(root: string): Promise<string> {
  for (const name of ['LICENSE', 'LICENSE.md']) {
    try {
      const text = Buffer.from(await readBoundedRegularFile(join(root, name))).toString('utf8');
      if (/CC0 1\.0 Universal/u.test(text)) return 'CC0-1.0';
      if (/MIT License/u.test(text)) return 'MIT';
      if (/Apache License[\s\S]*Version 2\.0/u.test(text)) return 'Apache-2.0';
    } catch {
      // A missing or untrusted license file must not turn into an invented license declaration.
    }
  }
  return 'UNLICENSED';
}

/**
 * Adapt the conventional `.agents/skills/<id>/SKILL.md` layout for composition only.
 * The compatibility boundary is deliberately narrow: auxiliary repository files are not
 * materialized, while each deployed SKILL.md is captured through the immutable snapshot reader.
 */
async function conventionalSkillSource(
  root: string,
): Promise<ConventionalSkillSource | ComposeSourceFailure | undefined> {
  const skillsRoot = join(root, '.agents', 'skills');
  let names: string[];
  try {
    const metadata = await lstat(skillsRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return {
        diagnostics: [
          sourceFailure(
            'E_PATH_CONVENTIONAL_SKILLS',
            '.agents/skills 必须是普通目录。',
            '移除符号链接或特殊文件后重试。',
            skillsRoot,
          ),
        ],
        exitCode: EXIT_CODES.SECURITY,
      };
    }
    names = (await readdir(skillsRoot)).filter((name) => CONVENTIONAL_SKILL_ID.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return {
      diagnostics: [
        sourceFailure(
          'E_SOURCE_CONVENTIONAL_SKILLS',
          '无法读取 .agents/skills 约定来源。',
          '检查来源目录权限后重试。',
          skillsRoot,
        ),
      ],
      exitCode: EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
    };
  }
  if (names.length === 0) return undefined;
  const allowed = new Set(names);
  let captured: Awaited<ReturnType<typeof captureSourceDirectory>>;
  try {
    captured = await captureSourceDirectory(skillsRoot, {
      skipPath: (path) => {
        const parts = path.split('/');
        const id = parts[0];
        return (
          id === undefined ||
          !allowed.has(id) ||
          parts.length > 2 ||
          (parts.length === 2 && parts[1] !== 'SKILL.md')
        );
      },
    });
  } catch (error) {
    const security = error instanceof SnapshotCaptureError && error.kind === 'security';
    return {
      diagnostics: [
        sourceFailure(
          security ? 'E_PATH_CONVENTIONAL_SKILLS' : 'E_SOURCE_CONVENTIONAL_SKILLS',
          security
            ? '.agents/skills 包含不安全的路径、链接或特殊文件。'
            : '.agents/skills 无法在受限快照中读取。',
          security ? '移除不安全条目后重试。' : '缩小来源或检查读取失败原因后重试。',
          error instanceof SnapshotCaptureError && error.path !== undefined
            ? error.path
            : skillsRoot,
        ),
      ],
      exitCode: security ? EXIT_CODES.SECURITY : EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
    };
  }
  const files = captured.files
    .filter(({ path }) => /^[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md$/u.test(path))
    .map(({ path, bytes }) => ({ path: `skills/${path}`, bytes }));
  if (files.length === 0) return undefined;
  const diagnostics = files.flatMap(({ path, bytes }) => {
    const content = Buffer.from(bytes).toString('utf8');
    return [...scanSecrets({ path, content }), ...inspectSkill(content, path)];
  });
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    return { diagnostics, exitCode: exitCodeFor(diagnostics) };
  }
  const materialFiles = files.map(({ path, bytes }) => ({
    path,
    sha512: digest('sha512', bytes),
    contentBase64: Buffer.from(bytes).toString('base64'),
  }));
  const license = await conventionalLicense(root);
  return {
    diagnostics: [
      diagnostic(
        'W_COMPOSE_CONVENTIONAL_SKILL_SOURCE',
        'warning',
        '已按 .agents/skills 约定识别来源技能；仅已校验的 SKILL.md 会进入组合。',
        '来源中的其他仓库文件不会部署。',
        skillsRoot,
      ),
      ...diagnostics,
    ],
    license,
    material: {
      manifest: {
        formatVersion: 0,
        name: 'conventional-skill-source',
        version: '0.0.0',
        description: 'Conventional external skill source.',
        author: 'external-source',
        license,
        dsh: { tested: ['0.1.0-rc.6'] },
        plugins: [],
        mcp: [],
        defaults: { permissionPreset: 'workspace-write' },
      },
      paths: materialFiles.map(({ path }) => path),
      files: materialFiles,
      sourceFiles: materialFiles.map(({ path, sha512 }) => ({ path, sha512 })),
      manifestDigest: digest(
        'sha256',
        Buffer.from(JSON.stringify(materialFiles.map(({ path, sha512 }) => ({ path, sha512 })))),
      ),
    },
  };
}

async function validated(
  root: string,
  from: string,
  cleanup: () => Promise<void>,
  readPack: typeof readValidatedPack,
  diagnostics: readonly Diagnostic[] = [],
): Promise<ComposeSourceResult> {
  const source = await readPack(root, { frozen: false });
  if (source.material === undefined) {
    const conventional = await conventionalSkillSource(root);
    if (conventional !== undefined) {
      if ('exitCode' in conventional) {
        await cleanup();
        return {
          diagnostics: [...diagnostics, ...conventional.diagnostics],
          exitCode: conventional.exitCode,
        };
      }
      return {
        cleanup,
        diagnostics: [...diagnostics, ...conventional.diagnostics],
        from,
        license: conventional.license,
        material: conventional.material,
      };
    }
    await cleanup();
    return { diagnostics: [...diagnostics, ...source.diagnostics], exitCode: source.exitCode };
  }
  return {
    cleanup,
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
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
    const from =
      materialized.provenance?.kind === 'github'
        ? sourceReferenceFromProvenance(materialized.provenance)
        : selection.from;
    return validated(
      materialized.directory,
      from,
      materialized.cleanup,
      dependencies.readPack ?? readValidatedPack,
      materialized.diagnostics,
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
