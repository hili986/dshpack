import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { type Diagnostic, type PackManifest, parseCompose, scanSecrets } from '@dshpack/core';
import { stringify } from 'yaml';

import { type CommandReport, diagnostic } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import { generateAndWriteLock } from '../lock/engine.js';
import { validateLocalPack } from '../validation/validate-pack.js';
import { resolveComposeConflicts } from './conflicts.js';
import {
  type ComposeMaterializedSource,
  isComposeMaterializedSource,
  materializeComposeSource,
  missingSkillDiagnostics,
  sourceSkills,
} from './sources.js';

export type { ComposeMaterializedSource } from './sources.js';

export interface ComposeInput {
  allowUnknownLicense?: boolean;
  composeFile: string;
  dryRun?: boolean;
  dshHome?: string;
  output?: string;
}

export interface ComposeMetadata {
  directory: string;
  dryRun: boolean;
  selected: readonly { from: string; id: string; originalId: string }[];
}

export type ComposeReport = CommandReport<ComposeMetadata>;

export interface ComposeDependencies {
  generateLock?: typeof generateAndWriteLock;
  materializeSource?: typeof materializeComposeSource;
  validate?: typeof validateLocalPack;
}

interface Material {
  bytes: Uint8Array;
  path: string;
}

function result(
  directory: string,
  dryRun: boolean,
  selected: ComposeMetadata['selected'],
  diagnostics: readonly Diagnostic[],
  exitCode: ComposeReport['exitCode'],
): ComposeReport {
  return { diagnostics, exitCode, metadata: { directory, dryRun, selected } };
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(({ severity }) => severity === 'error');
}

/**
 * Source adapters classify their own failures — a tampered tarball is `SOURCE_INTEGRITY` / 20, a
 * path or credential hit is 31. Folding those into the generic contract code would tell the caller
 * "your compose.yml is wrong" when the truth is "that tarball was tampered with", and automation
 * reading the exit code would retry a fetch it must not retry. So carry the adapter's own code
 * through as `adapterExit`, and let a credential hit still override it — the same rule
 * `exitCodeFor` states: security never gets downgraded to contract noise.
 */
function failureExit(
  diagnostics: readonly Diagnostic[],
  adapterExit?: ComposeReport['exitCode'],
): ComposeReport['exitCode'] {
  if (diagnostics.some(({ code }) => code.startsWith('E_SECRET'))) return EXIT_CODES.SECURITY;
  return adapterExit ?? EXIT_CODES.CONTRACT;
}

function stagingDirectory(output: string): string {
  return join(
    dirname(output),
    `.${basename(output)}.dshpack-compose-${randomBytes(8).toString('hex')}`,
  );
}

function outputPath(composeFile: string, name: string, output?: string): string {
  return resolve(output ?? join(dirname(composeFile), name));
}

async function outputAvailable(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function materialPath(item: { id: string; originalPath: string; sourcePath: string }): string {
  if (item.sourcePath === '' && item.originalPath.endsWith('.md')) return `skills/${item.id}.md`;
  return `skills/${item.id}/${item.sourcePath}`;
}

function originalSkillId(path: string): string {
  const entry = path.split('/')[1] as string;
  return entry.endsWith('.md') ? entry.slice(0, -3) : entry;
}

function scan(materials: readonly Material[]): Diagnostic[] {
  return materials.flatMap(({ bytes, path }) =>
    scanSecrets({ path, content: Buffer.from(bytes).toString('utf8') }).filter(
      ({ code }) => !(path === 'pack.lock.yml' && code === 'E_SECRET_HIGH_ENTROPY'),
    ),
  );
}

async function collect(root: string): Promise<Material[]> {
  const output: Material[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort((left, right) =>
      left.localeCompare(right),
    )) {
      const absolute = join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        await visit(absolute);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        output.push({
          bytes: await readFile(absolute),
          path: relative(root, absolute).split(sep).join('/'),
        });
      }
    }
  };
  await visit(root);
  return output;
}

async function writeMaterials(root: string, materials: readonly Material[]): Promise<void> {
  for (const material of materials) {
    const target = join(root, ...material.path.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, material.bytes, { flag: 'wx', mode: 0o600 });
  }
}

function licenseDiagnostics(source: ComposeMaterializedSource, declared: string): Diagnostic[] {
  if (source.license === undefined || source.license === 'UNLICENSED') {
    return [
      diagnostic(
        'W_COMPOSE_UNKNOWN_LICENSE',
        'warning',
        `source ${source.from} 未声明可用 license。`,
        '显式传入 --allow-unknown-license 后才可继续。',
        source.from,
      ),
    ];
  }
  if (source.license === declared) return [];
  return [
    diagnostic(
      'W_COMPOSE_LICENSE_MISMATCH',
      'warning',
      `source ${source.from} 的 license ${source.license} 与新 pack 声明 ${declared} 不同。`,
      '来源 license 会原样写入 provenance，不会自动改写。',
      source.from,
    ),
  ];
}

/** Compose selected source skills in a sibling staging directory and publish only after every gate. */
export async function composePack(
  input: ComposeInput,
  dependencies: ComposeDependencies = {},
): Promise<ComposeReport> {
  const composeFile = resolve(input.composeFile);
  let sourceText: string;
  try {
    sourceText = await readFile(composeFile, 'utf8');
  } catch {
    return result(
      input.output ?? '',
      input.dryRun === true,
      [],
      [
        diagnostic(
          'E_COMPOSE_READ',
          'error',
          '无法读取 compose.yml。',
          '检查文件路径与权限后重试。',
          composeFile,
        ),
      ],
      EXIT_CODES.CONTRACT,
    );
  }
  const parsed = parseCompose(sourceText);
  const provisionalOutput = input.output === undefined ? '' : resolve(input.output);
  if (parsed.value === undefined)
    return result(
      provisionalOutput,
      input.dryRun === true,
      [],
      parsed.diagnostics,
      EXIT_CODES.CONTRACT,
    );
  const compose = parsed.value;
  const output = outputPath(composeFile, compose.name, input.output);
  const materialize = dependencies.materializeSource ?? materializeComposeSource;
  const sources: ComposeMaterializedSource[] = [];
  const diagnostics: Diagnostic[] = [];
  // First adapter code wins: every source is reported, but the exit code names one category, and
  // the earliest failure is the one whose diagnostic the reader hits first.
  let adapterExit: ComposeReport['exitCode'] | undefined;
  try {
    for (const selection of compose.include) {
      const materialized = await materialize(selection, composeFile, input.dshHome);
      if (!isComposeMaterializedSource(materialized)) {
        diagnostics.push(...materialized.diagnostics);
        adapterExit ??= materialized.exitCode;
        continue;
      }
      sources.push(materialized);
    }
    if (hasErrors(diagnostics))
      return result(
        output,
        input.dryRun === true,
        [],
        diagnostics,
        failureExit(diagnostics, adapterExit),
      );

    const selectedItems = [] as ReturnType<typeof sourceSkills>['items'];
    for (const [index, source] of sources.entries()) {
      const selection = compose.include[index] as (typeof compose.include)[number];
      const selectionResult = sourceSkills(source, selection);
      diagnostics.push(...missingSkillDiagnostics(source, selection, selectionResult.available));
      selectedItems.push(...selectionResult.items);
      diagnostics.push(...licenseDiagnostics(source, compose.license));
    }
    if (hasErrors(diagnostics))
      return result(output, input.dryRun === true, [], diagnostics, failureExit(diagnostics));

    const conflicts = resolveComposeConflicts(selectedItems, compose.resolve ?? []);
    diagnostics.push(...conflicts.diagnostics);
    if (hasErrors(diagnostics))
      return result(output, input.dryRun === true, [], diagnostics, EXIT_CODES.CONTRACT);

    const selected = conflicts.items.map(({ from, id, originalPath }) => ({
      from,
      id,
      originalId: originalSkillId(originalPath),
    }));
    const unknownLicense = diagnostics.some(({ code }) => code === 'W_COMPOSE_UNKNOWN_LICENSE');
    if (unknownLicense && input.allowUnknownLicense !== true) {
      diagnostics.push(
        diagnostic(
          'E_COMPOSE_UNKNOWN_LICENSE_CONFIRM',
          'error',
          'source license 不明，尚未获得危险确认。',
          '显式传入 --allow-unknown-license 以确认继续。',
        ),
      );
      return result(output, input.dryRun === true, selected, diagnostics, EXIT_CODES.USER_DECLINED);
    }

    if (input.dryRun === true)
      return result(output, true, selected, diagnostics, EXIT_CODES.SUCCESS);
    if (!(await outputAvailable(output))) {
      diagnostics.push(
        diagnostic(
          'E_COMPOSE_OUTPUT',
          'error',
          'compose 输出目录必须不存在，拒绝覆盖。',
          '选择一个新的 --output 目录。',
          output,
        ),
      );
      return result(output, false, selected, diagnostics, EXIT_CODES.CONTRACT);
    }

    const provenance = conflicts.items
      .filter(({ sourcePath }) => sourcePath === '' || sourcePath === 'SKILL.md')
      .map(({ from, id, license, originalPath }) => ({
        id,
        from,
        originalId: originalSkillId(originalPath),
        license: license === undefined ? 'UNLICENSED' : license,
      }))
      .sort((left, right) => left.id.localeCompare(right.id, 'en'));
    const manifest: PackManifest = {
      formatVersion: 0,
      name: compose.name,
      version: compose.version,
      description: compose.description,
      author: compose.author,
      license: compose.license,
      dsh: { tested: ['0.1.0-rc.6'] },
      plugins: [],
      mcp: compose.mcp ?? [],
      defaults: compose.defaults,
      provenance,
    };
    const materials: Material[] = [
      { path: 'pack.yml', bytes: Buffer.from(stringify(manifest, { lineWidth: 0 })) },
      { path: 'patch/cordis.patch.yml', bytes: Buffer.from('[]\n') },
      ...conflicts.items.map((item) => ({ bytes: item.bytes, path: materialPath(item) })),
    ];
    const firstScan = scan(materials);
    if (firstScan.length > 0)
      return result(output, false, selected, [...diagnostics, ...firstScan], EXIT_CODES.SECURITY);

    const staging = stagingDirectory(output);
    try {
      await mkdir(staging, { mode: 0o700 });
      await writeMaterials(staging, materials);
      const beforeLock = scan(await collect(staging));
      if (beforeLock.length > 0)
        return result(
          output,
          false,
          selected,
          [...diagnostics, ...beforeLock],
          EXIT_CODES.SECURITY,
        );
      const locked = await (dependencies.generateLock ?? generateAndWriteLock)(staging);
      if (locked.exitCode !== EXIT_CODES.SUCCESS)
        return result(
          output,
          false,
          selected,
          [...diagnostics, ...locked.diagnostics],
          locked.exitCode,
        );
      const postLock = scan(await collect(staging));
      if (postLock.length > 0)
        return result(output, false, selected, [...diagnostics, ...postLock], EXIT_CODES.SECURITY);
      const validated = await (dependencies.validate ?? validateLocalPack)(staging, {
        strict: true,
      });
      if (validated.exitCode !== EXIT_CODES.SUCCESS)
        return result(
          output,
          false,
          selected,
          [...diagnostics, ...validated.diagnostics],
          validated.exitCode,
        );
      await rename(staging, output);
      return result(output, false, selected, diagnostics, EXIT_CODES.SUCCESS);
    } catch {
      diagnostics.push(
        diagnostic(
          'E_COMPOSE_WRITE',
          'error',
          '无法写入或发布 compose 输出。',
          '检查输出父目录权限后重试。',
          output,
        ),
      );
      return result(output, false, selected, diagnostics, EXIT_CODES.CONTRACT);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    await Promise.all(sources.map(({ cleanup }) => cleanup().catch(() => undefined)));
  }
}
