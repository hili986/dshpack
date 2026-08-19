import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { type Diagnostic, parsePack, scanSecrets } from '@dshpack/core';
import { c as createTar } from 'tar';

import { type CommandReport, diagnostic } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import {
  classifyPackPath,
  isIgnoredPackPath,
  validateLocalPack,
} from '../validation/validate-pack.js';

export interface PackInput {
  directory: string;
  output?: string;
}

export interface PackedFile {
  path: string;
  sha256: string;
}

export interface PackMetadata {
  archive?: string;
  files?: readonly PackedFile[];
  manifest?: string;
  output: string;
  sri?: string;
}

export type PackReport = CommandReport<PackMetadata>;

export interface PackDependencies {
  onScanPhase?: (phase: 'collect' | 'write' | 'post-write') => Promise<void>;
  validate?: typeof validateLocalPack;
}

interface SourceFile {
  absolute: string;
  bytes: Uint8Array;
  path: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha512(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function posixRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join('/');
}

function failed(output: string, diagnostics: readonly Diagnostic[], exitCode?: number): PackReport {
  return {
    diagnostics,
    exitCode: (exitCode ??
      (diagnostics.some(({ code }) => code.startsWith('E_SECRET'))
        ? EXIT_CODES.SECURITY
        : EXIT_CODES.CONTRACT)) as PackReport['exitCode'],
    metadata: { output },
  };
}

function securityFailed(output: string, diagnostics: readonly Diagnostic[]): PackReport {
  return { diagnostics, exitCode: EXIT_CODES.SECURITY, metadata: { output } };
}

async function collect(root: string, output: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const outputRelative = posixRelative(root, output);
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort((left, right) =>
      left.localeCompare(right),
    )) {
      const absolute = join(directory, name);
      const path = posixRelative(root, absolute);
      if (
        isIgnoredPackPath(path) ||
        path === outputRelative ||
        path.startsWith(`${outputRelative}/`)
      )
        continue;
      const state = await lstat(absolute);
      if (state.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!state.isFile() || state.isSymbolicLink() || classifyPackPath(path) === undefined)
        continue;
      files.push({ absolute, bytes: await readFile(absolute), path });
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function scan(files: readonly SourceFile[]): Diagnostic[] {
  return files.flatMap(({ bytes, path }) =>
    scanSecrets({ path, content: Buffer.from(bytes).toString('utf8') }).filter(
      ({ code }) => !(path === 'pack.lock.yml' && code === 'E_SECRET_HIGH_ENTROPY'),
    ),
  );
}

function stageDirectory(output: string): string {
  return join(
    dirname(output),
    `.${basename(output)}.dshpack-pack-${randomBytes(8).toString('hex')}`,
  );
}

function artifactNames(
  name: string,
  version: string,
): {
  archive: string;
  manifest: string;
  sri: string;
} {
  const base = `${name}-${version}.tgz`;
  return { archive: base, sri: `${base}.sha512`, manifest: `${base}.manifest.json` };
}

async function publish(
  staging: string,
  output: string,
  names: ReturnType<typeof artifactNames>,
): Promise<void> {
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (const name of [names.archive, names.sri, names.manifest]) {
    await rename(join(staging, name), join(output, name));
  }
}

/** Securely package a validated directory; no source bytes are edited or redacted on secret hits. */
export async function packDirectory(
  input: PackInput,
  dependencies: PackDependencies = {},
): Promise<PackReport> {
  const root = resolve(input.directory);
  const output = resolve(input.output ?? join(root, 'dist'));
  const validate = dependencies.validate ?? validateLocalPack;
  const outputRelative = posixRelative(root, output);
  const ignoredPaths =
    outputRelative === '..' || outputRelative.startsWith('../') ? [] : [outputRelative];
  const validated = await validate(root, { strict: true, ignoredPaths });
  if (validated.exitCode !== EXIT_CODES.SUCCESS)
    return failed(output, validated.diagnostics, validated.exitCode);

  let first: SourceFile[];
  try {
    await dependencies.onScanPhase?.('collect');
    first = await collect(root, output);
  } catch {
    return failed(output, [
      diagnostic('E_PACK_READ', 'error', '无法读取 pack 文件。', '检查目录权限后重试。'),
    ]);
  }
  const firstSecrets = scan(first);
  if (firstSecrets.length > 0) return securityFailed(output, firstSecrets);

  const manifestSource = first.find(({ path }) => path === 'pack.yml');
  const manifest =
    manifestSource === undefined
      ? undefined
      : parsePack(Buffer.from(manifestSource.bytes).toString('utf8')).value;
  if (manifest === undefined)
    return failed(output, [
      diagnostic('E_PACK_MANIFEST', 'error', '无法解析 pack.yml。', '先修复 manifest 后重试。'),
    ]);

  const names = artifactNames(manifest.name, manifest.version);
  const staging = stageDirectory(output);
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await dependencies.onScanPhase?.('write');
    const beforeWrite = await collect(root, output);
    const beforeWriteSecrets = scan(beforeWrite);
    if (beforeWriteSecrets.length > 0) return securityFailed(output, beforeWriteSecrets);
    const semanticBeforeWrite = beforeWrite.filter(
      ({ path }) => classifyPackPath(path) === 'semantic',
    );
    const archive = join(staging, names.archive);
    await createTar(
      {
        cwd: root,
        file: archive,
        gzip: { level: 9 },
        mtime: new Date(0),
        noPax: true,
        portable: true,
        mode: 0o644,
      },
      semanticBeforeWrite.map(({ path }) => path),
    );
    await dependencies.onScanPhase?.('post-write');
    const afterWrite = await collect(root, output);
    const afterWriteSecrets = scan(afterWrite);
    if (afterWriteSecrets.length > 0) return securityFailed(output, afterWriteSecrets);
    const semanticAfterWrite = afterWrite.filter(
      ({ path }) => classifyPackPath(path) === 'semantic',
    );
    const archiveBytes = await readFile(archive);
    const sri = sha512(archiveBytes);
    const files = semanticAfterWrite.map(({ bytes, path }) => ({ path, sha256: sha256(bytes) }));
    await writeFile(join(staging, names.sri), `${sri}\n`, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(staging, names.manifest), `${JSON.stringify({ files }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await publish(staging, output, names);
    return {
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        archive: join(output, names.archive),
        files,
        manifest: join(output, names.manifest),
        output,
        sri,
      },
    };
  } catch {
    return failed(output, [
      diagnostic('E_PACK_WRITE', 'error', '无法写入 pack 归档。', '检查输出目录权限后重试。'),
    ]);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
