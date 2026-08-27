import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { Diagnostic } from '@dshpack/core';
import { x as extractTar, Parser, type ReadEntry } from 'tar';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 4096;

type ArchiveError = (code: string, message: string) => Error;

export interface GitHubArchiveExpectation {
  commit: string;
}

interface ArchiveState {
  paths: Map<string, string>;
  terminals: Set<string>;
  parents: Set<string>;
  filePaths: Set<string>;
  bytes: number;
  diagnostics: Diagnostic[];
  githubRootName: string | undefined;
}

interface ArchiveInspection {
  diagnostics: readonly Diagnostic[];
  githubRoot: string | undefined;
}

function dataAfterNul(block: Buffer, offset: number, length: number): boolean {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return nul >= 0 && field.subarray(nul + 1).some((byte) => byte !== 0);
}

async function rawHeadersSafe(filename: string): Promise<boolean> {
  let pending = Buffer.alloc(0);
  let remaining = 0;
  let expanded = 0;
  try {
    const stream = createReadStream(filename).pipe(createGunzip());
    for await (const value of stream) {
      const chunk = Buffer.from(value);
      expanded += chunk.byteLength;
      if (expanded > 12 * 1024 * 1024) return false;
      pending = Buffer.concat([pending, chunk]);
      while (pending.byteLength >= 512) {
        const block = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (remaining > 0) {
          remaining -= 512;
          continue;
        }
        if (block.every((byte) => byte === 0)) continue;
        if (dataAfterNul(block, 0, 100) || dataAfterNul(block, 345, 155)) return false;
        const sizeField = block.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
        if (!/^[0-7]+$/u.test(sizeField)) return false;
        remaining = Math.ceil(Number.parseInt(sizeField, 8) / 512) * 512;
      }
    }
  } catch {
    return false;
  }
  return pending.byteLength === 0 && remaining === 0;
}

function safeEntryPath(entry: ReadEntry, fail: ArchiveError): string {
  const raw =
    entry.type === 'Directory' && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
  if (
    raw === '' ||
    isAbsolute(raw) ||
    /^[A-Za-z]:/u.test(raw) ||
    raw.includes('\\') ||
    entry.header.path?.includes('\\') === true ||
    /\p{Cc}/u.test(raw)
  ) {
    throw fail('ARCHIVE_UNSAFE', '归档包含不安全路径。');
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      /[<>:"|?*\uF000-\uF0FF]/u.test(segment) ||
      /[. ]$/u.test(segment) ||
      /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(
        segment,
      )
    ) {
      throw fail('ARCHIVE_UNSAFE', '归档包含不安全路径。');
    }
  }
  return raw;
}

function deployableEntry(entry: ReadEntry): boolean {
  return entry.type === 'File' || entry.type === 'OldFile' || entry.type === 'Directory';
}

function skippedEntryDiagnostic(path: string): Diagnostic {
  return {
    code: 'E_ARCHIVE_ENTRY_SKIPPED',
    severity: 'warning',
    message: `已跳过非普通归档条目：${path}。`,
    hint: '该条目未部署，也未跟随其链接目标。',
    evidence: 'local',
    path,
  };
}

function inspectEntry(
  entry: ReadEntry,
  state: ArchiveState,
  fail: ArchiveError,
  expectedGitHub?: GitHubArchiveExpectation,
): void {
  const global = entry.globalExtended;
  const unsafeGlobal =
    global !== undefined &&
    (expectedGitHub === undefined ||
      global.comment !== expectedGitHub.commit ||
      Object.entries(global).some(
        ([key, value]) => value !== undefined && key !== 'global' && key !== 'comment',
      ));
  if (entry.extended !== undefined || unsafeGlobal) {
    throw fail('ARCHIVE_UNSAFE', '归档包含扩展元数据。');
  }
  const path = safeEntryPath(entry, fail);
  const segments = path.split('/');
  if (expectedGitHub !== undefined) {
    const root = segments[0] as string;
    state.githubRootName ??= root;
    if (root !== state.githubRootName)
      throw fail('ARCHIVE_UNSAFE', 'GitHub codeload 归档包含多个顶层目录。');
  }
  if (!deployableEntry(entry)) {
    state.diagnostics.push(skippedEntryDiagnostic(path));
    return;
  }
  const leafCanonical = segments.join('/').normalize('NFC').toLowerCase();
  for (let index = 1; index <= segments.length; index += 1) {
    const original = segments.slice(0, index).join('/');
    const canonical = original.normalize('NFC').toLowerCase();
    const previous = state.paths.get(canonical);
    if (previous !== undefined && previous !== original) {
      throw fail('ARCHIVE_COLLISION', '归档路径在目标文件系统上发生冲突。');
    }
    state.paths.set(canonical, original);
    if (index < segments.length) {
      if (state.filePaths.has(canonical)) throw fail('ARCHIVE_COLLISION', '归档文件路径包含后代。');
      state.parents.add(canonical);
    }
    if (index === segments.length) {
      if (state.terminals.has(canonical)) throw fail('ARCHIVE_COLLISION', '归档包含重复路径。');
      if (entry.type !== 'Directory' && state.parents.has(canonical)) {
        throw fail('ARCHIVE_COLLISION', '归档文件路径与目录冲突。');
      }
      state.terminals.add(canonical);
    }
  }
  if (entry.type === 'Directory') {
    if (entry.size !== 0) throw fail('ARCHIVE_UNSAFE', '归档目录条目无效。');
    return;
  }
  state.filePaths.add(leafCanonical);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) {
    throw fail('ARCHIVE_LIMIT', '归档单文件超过 1 MiB 限制。');
  }
  state.bytes += entry.size;
  if (state.bytes > MAX_TOTAL_BYTES) {
    throw fail('ARCHIVE_LIMIT', '归档超过总大小限制。');
  }
}

async function preflight(
  filename: string,
  fail: ArchiveError,
  expectedGitHub?: GitHubArchiveExpectation,
): Promise<ArchiveInspection> {
  if (!(await rawHeadersSafe(filename)))
    throw fail('ARCHIVE_UNSAFE', '归档原始 header 不安全或无效。');
  const state: ArchiveState = {
    paths: new Map<string, string>(),
    terminals: new Set<string>(),
    parents: new Set<string>(),
    filePaths: new Set<string>(),
    bytes: 0,
    diagnostics: [],
    githubRootName: undefined,
  };
  let entries = 0;
  let metaHeaders = 0;
  let consumedMeta = 0;
  let sawGlobal = false;
  let failure: Error | undefined;
  let parserError: unknown;
  const record = (error: Error): void => {
    failure ??= error;
  };
  try {
    const parser = new Parser({ file: filename, strict: true });
    parser.on('meta', () => {
      metaHeaders += 1;
    });
    parser.on('ignoredEntry', (entry: ReadEntry) => {
      record(fail('ARCHIVE_UNSAFE', '归档包含未允许的 header。'));
      entry.resume();
    });
    parser.on('entry', (entry: ReadEntry) => {
      entries += 1;
      if (entries > MAX_ENTRIES) record(fail('ARCHIVE_LIMIT', '归档超过条目数量限制。'));
      if (entry.globalExtended !== undefined && !sawGlobal) {
        sawGlobal = true;
        consumedMeta += 1;
      }
      if (failure === undefined) {
        try {
          inspectEntry(entry, state, fail, expectedGitHub);
        } catch (error) {
          record(error instanceof Error ? error : fail('ARCHIVE_UNSAFE', '归档检查失败。'));
        }
      }
      entry.resume();
    });
    const ended = once(parser, 'end').catch((error: unknown) => {
      parserError = error;
    });
    for await (const chunk of createReadStream(filename)) {
      if (!parser.write(chunk)) await once(parser, 'drain');
    }
    parser.end();
    await ended;
    if (parserError !== undefined) throw parserError;
  } catch {
    if (failure !== undefined) throw failure;
    throw fail('ARCHIVE_UNSAFE', '归档格式无效或无法安全读取。');
  }
  if (failure !== undefined) throw failure;
  if (metaHeaders !== consumedMeta) throw fail('ARCHIVE_UNSAFE', '归档包含未允许的 header。');
  if (entries === 0) throw fail('ARCHIVE_UNSAFE', '归档为空或无效。');
  return { diagnostics: state.diagnostics, githubRoot: state.githubRootName };
}

export async function inspectAndExtractArchive(
  archivePath: string,
  workspace: string,
  fail: ArchiveError,
  expectedGitHub?: GitHubArchiveExpectation,
): Promise<{ directory: string; diagnostics: readonly Diagnostic[] }> {
  const { diagnostics, githubRoot } = await preflight(archivePath, fail, expectedGitHub);
  const directory = join(workspace, 'contents');
  await mkdir(directory, { mode: 0o700 });
  try {
    await extractTar({
      file: archivePath,
      cwd: directory,
      strict: true,
      preservePaths: false,
      win32: false,
      noChmod: true,
      filter: (_path, entry) => deployableEntry(entry as ReadEntry),
    });
  } catch {
    throw fail('ARCHIVE_UNSAFE', '归档无法安全解包。');
  }
  if (githubRoot === undefined) return { directory, diagnostics };
  const root = join(directory, githubRoot);
  const metadata = await lstat(root).catch(() => undefined);
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink())
    throw fail('ARCHIVE_UNSAFE', 'GitHub codeload 顶层条目不是普通目录。');
  return { directory: root, diagnostics };
}
