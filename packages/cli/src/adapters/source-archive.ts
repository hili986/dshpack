import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { x as extractTar, t as inspectTar, type ReadEntry } from 'tar';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 1000;

type ArchiveError = (code: string, message: string) => Error;

function safeEntryPath(entry: ReadEntry, fail: ArchiveError): string {
  const raw =
    entry.type === 'Directory' && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
  const hasControl = [...raw].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (
    raw === '' ||
    isAbsolute(raw) ||
    /^[A-Za-z]:/u.test(raw) ||
    raw.includes('\\') ||
    entry.header.path?.includes('\\') === true ||
    hasControl
  ) {
    throw fail('ARCHIVE_UNSAFE', '归档包含不安全路径。');
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes(':') ||
      /[. ]$/u.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
    ) {
      throw fail('ARCHIVE_UNSAFE', '归档包含不安全路径。');
    }
  }
  return raw;
}

function inspectEntry(
  entry: ReadEntry,
  state: { paths: Map<string, string>; terminals: Set<string>; files: number; bytes: number },
  fail: ArchiveError,
): void {
  if (entry.type !== 'File' && entry.type !== 'OldFile' && entry.type !== 'Directory') {
    throw fail('ARCHIVE_UNSAFE', '归档包含链接或特殊文件。');
  }
  const segments = safeEntryPath(entry, fail).split('/');
  for (let index = 1; index <= segments.length; index += 1) {
    const original = segments.slice(0, index).join('/');
    const canonical = original.normalize('NFC').toLowerCase();
    const previous = state.paths.get(canonical);
    if (previous !== undefined && previous !== original) {
      throw fail('ARCHIVE_COLLISION', '归档路径在目标文件系统上发生冲突。');
    }
    state.paths.set(canonical, original);
    if (index === segments.length) {
      if (state.terminals.has(canonical)) throw fail('ARCHIVE_COLLISION', '归档包含重复路径。');
      state.terminals.add(canonical);
    }
  }
  if (entry.type === 'Directory') {
    if (entry.size !== 0) throw fail('ARCHIVE_UNSAFE', '归档目录条目无效。');
    return;
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) {
    throw fail('ARCHIVE_LIMIT', '归档单文件超过 1 MiB 限制。');
  }
  state.files += 1;
  state.bytes += entry.size;
  if (state.files > MAX_FILES || state.bytes > MAX_TOTAL_BYTES) {
    throw fail('ARCHIVE_LIMIT', '归档超过文件数量或总大小限制。');
  }
}

async function preflight(filename: string, fail: ArchiveError): Promise<void> {
  const state = {
    paths: new Map<string, string>(),
    terminals: new Set<string>(),
    files: 0,
    bytes: 0,
  };
  let entries = 0;
  let failure: Error | undefined;
  try {
    await inspectTar({
      file: filename,
      strict: true,
      preservePaths: true,
      win32: false,
      onReadEntry: (entry) => {
        entries += 1;
        if (failure !== undefined) return;
        try {
          inspectEntry(entry, state, fail);
        } catch (error) {
          failure = error instanceof Error ? error : fail('ARCHIVE_UNSAFE', '归档检查失败。');
        }
      },
    });
  } catch {
    throw fail('ARCHIVE_UNSAFE', '归档格式无效或无法安全读取。');
  }
  if (failure !== undefined) throw failure;
  if (entries === 0) throw fail('ARCHIVE_UNSAFE', '归档为空或无效。');
}

export async function inspectAndExtractArchive(
  archivePath: string,
  workspace: string,
  fail: ArchiveError,
): Promise<string> {
  await preflight(archivePath, fail);
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
    });
  } catch {
    throw fail('ARCHIVE_UNSAFE', '归档无法安全解包。');
  }
  return directory;
}
