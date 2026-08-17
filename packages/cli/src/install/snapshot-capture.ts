import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  assertPortableSnapshotEntries,
  assertPortableSnapshotPath,
  SnapshotCaptureError,
} from './snapshot-path.js';

export { assertPortableSnapshotEntries, SnapshotCaptureError } from './snapshot-path.js';

export const MAX_SOURCE_FILES = 1000;
export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
export const MAX_SOURCE_TOTAL_BYTES = 10 * 1024 * 1024;

export interface SnapshotStat {
  kind: 'file' | 'directory' | 'symlink' | 'special';
  dev: number;
  ino: number;
  size: number;
  birthtimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink?: number;
}

export interface SnapshotFileHandle {
  stat(): Promise<SnapshotStat>;
  read(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface BoundedReadDependencies {
  lstatPath?: (path: string) => Promise<SnapshotStat>;
  openFile?: (path: string, flags?: number) => Promise<SnapshotFileHandle>;
}

export interface SnapshotCaptureDependencies extends BoundedReadDependencies {
  realpathPath?: (path: string) => Promise<string>;
  listDirectory?: (path: string) => AsyncIterable<{ name: string }>;
  /** Skip a relative entry before lstat or descent, for ignored source trees such as .git/. */
  skipPath?: (path: string) => boolean;
}

export interface CapturedSnapshotFile {
  path: string;
  bytes: Uint8Array;
}

export interface CapturedSourceDirectory {
  entries: readonly { path: string; kind: 'file' | 'directory' }[];
  files: readonly CapturedSnapshotFile[];
}

function statKind(value: Awaited<ReturnType<typeof lstat>>): SnapshotStat['kind'] {
  if (value.isSymbolicLink()) return 'symlink';
  if (value.isFile()) return 'file';
  if (value.isDirectory()) return 'directory';
  return 'special';
}

async function defaultLstat(path: string): Promise<SnapshotStat> {
  const value = await lstat(path);
  return {
    kind: statKind(value),
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    birthtimeMs: value.birthtimeMs,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
    nlink: value.nlink,
  };
}

const REGULAR_FILE_READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0);

async function defaultOpen(
  path: string,
  flags = REGULAR_FILE_READ_FLAGS,
): Promise<SnapshotFileHandle> {
  const handle = await open(path, flags);
  return {
    stat: async () => {
      const value = await handle.stat();
      return {
        kind: statKind(value),
        dev: value.dev,
        ino: value.ino,
        size: value.size,
        birthtimeMs: value.birthtimeMs,
        mtimeMs: value.mtimeMs,
        ctimeMs: value.ctimeMs,
        nlink: value.nlink,
      };
    },
    read: async (buffer, offset, length) => handle.read(buffer, offset, length, null),
    close: () => handle.close(),
  };
}

async function* defaultListDirectory(path: string): AsyncIterable<{ name: string }> {
  const directory = await opendir(path);
  for await (const entry of directory) yield { name: entry.name };
}

function sameIdentity(left: SnapshotStat, right: SnapshotStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function stableFile(left: SnapshotStat, right: SnapshotStat): boolean {
  return (
    sameIdentity(left, right) &&
    left.kind === 'file' &&
    right.kind === 'file' &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.nlink === right.nlink
  );
}

/** Same-handle, bounded streaming read. It never asks Node to allocate the whole file. */
export async function readBoundedRegularFile(
  path: string,
  dependencies: BoundedReadDependencies = {},
  expected?: SnapshotStat,
  maximumBytes = MAX_SOURCE_FILE_BYTES,
  requireSingleLink = false,
): Promise<Uint8Array> {
  const lstatPath = dependencies.lstatPath ?? defaultLstat;
  const openFile = dependencies.openFile ?? defaultOpen;
  const before = await lstatPath(path);
  if (before.kind !== 'file' || (expected !== undefined && !sameIdentity(before, expected))) {
    throw new SnapshotCaptureError('security', 'source file is not stable and regular', path);
  }
  if (requireSingleLink && before.nlink !== 1) {
    throw new SnapshotCaptureError('security', 'source file is not singly linked', path);
  }
  if (before.size > maximumBytes) {
    throw new SnapshotCaptureError(
      'limit',
      `source file exceeds ${String(maximumBytes)} bytes`,
      path,
    );
  }
  let handle: SnapshotFileHandle;
  try {
    handle = await openFile(path, REGULAR_FILE_READ_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ELOOP') {
      throw new SnapshotCaptureError('security', 'source file changed to a link before open', path);
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (
      !sameIdentity(before, opened) ||
      opened.kind !== 'file' ||
      (requireSingleLink && opened.nlink !== 1)
    ) {
      throw new SnapshotCaptureError('security', 'source file changed before open', path);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > chunk.byteLength) {
        throw new SnapshotCaptureError('security', 'source file returned an invalid read', path);
      }
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) {
        throw new SnapshotCaptureError(
          'limit',
          `source file grew beyond ${String(maximumBytes)} bytes`,
          path,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const [after, current] = await Promise.all([handle.stat(), lstatPath(path)]);
    if (!stableFile(opened, after) || !stableFile(after, current)) {
      throw new SnapshotCaptureError('security', 'source file changed during capture', path);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}

/**
 * The nearest ancestor of `path` that is a link, or undefined when the chain up to the
 * drive root is ordinary directories.
 *
 * Asked by inspecting the ancestors, not by comparing the caller's spelling of the root
 * against its realpath: on Windows an 8.3 alias names the very same directory through no
 * link at all, yet compares unequal, which refused ordinary SOURCE directories outright.
 * An ancestor that cannot be inspected is one we cannot vouch for, so it counts as linked.
 */
async function linkedAncestor(
  path: string,
  lstatPath: (path: string) => Promise<SnapshotStat>,
): Promise<string | undefined> {
  for (let current = dirname(resolve(path)); ; ) {
    let stats: SnapshotStat;
    try {
      stats = await lstatPath(current);
    } catch {
      return current;
    }
    if (stats.kind === 'symlink') return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function within(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

async function assertCanonical(
  logicalRoot: string,
  canonicalRoot: string,
  candidate: string,
  realpathPath: (path: string) => Promise<string>,
): Promise<void> {
  const actual = await realpathPath(candidate);
  const expected = resolve(canonicalRoot, relative(logicalRoot, resolve(candidate)));
  if (!within(canonicalRoot, actual) || !samePath(actual, expected)) {
    throw new SnapshotCaptureError('security', 'source ancestor escaped through a link', candidate);
  }
}

export async function captureSourceDirectory(
  root: string,
  dependencies: SnapshotCaptureDependencies = {},
): Promise<CapturedSourceDirectory> {
  const lstatPath = dependencies.lstatPath ?? defaultLstat;
  const realpathPath = dependencies.realpathPath ?? realpath;
  const listDirectory = dependencies.listDirectory ?? defaultListDirectory;
  const skipPath = dependencies.skipPath ?? (() => false);
  const logicalRoot = resolve(root);
  const rootBefore = await lstatPath(logicalRoot);
  if (rootBefore.kind !== 'directory') {
    throw new SnapshotCaptureError('security', 'SOURCE root is not a regular directory', root);
  }
  const canonicalRoot = await realpathPath(logicalRoot);
  const linked = await linkedAncestor(logicalRoot, lstatPath);
  if (linked !== undefined) {
    throw new SnapshotCaptureError(
      'security',
      `SOURCE path contains a symbolic-link or junction ancestor: ${linked}`,
      root,
    );
  }
  await assertCanonical(logicalRoot, canonicalRoot, logicalRoot, realpathPath);
  const entries: { path: string; kind: 'file' | 'directory' }[] = [];
  const files: CapturedSnapshotFile[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const visit = async (directory: string, expected: SnapshotStat): Promise<void> => {
    const before = await lstatPath(directory);
    if (before.kind !== 'directory' || !sameIdentity(before, expected)) {
      throw new SnapshotCaptureError(
        'security',
        'source directory changed before traversal',
        directory,
      );
    }
    await assertCanonical(logicalRoot, canonicalRoot, directory, realpathPath);
    for await (const item of listDirectory(directory)) {
      const absolute = resolve(directory, item.name);
      const path = relative(logicalRoot, absolute).split(sep).join('/');
      assertPortableSnapshotPath(path);
      if (skipPath(path)) continue;
      const metadata = await lstatPath(absolute);
      if (metadata.kind === 'directory') {
        entries.push({ path, kind: 'directory' });
        await visit(absolute, metadata);
      } else if (metadata.kind === 'file') {
        fileCount += 1;
        if (fileCount > MAX_SOURCE_FILES) {
          throw new SnapshotCaptureError('limit', 'SOURCE exceeds 1000 files', path);
        }
        await assertCanonical(logicalRoot, canonicalRoot, absolute, realpathPath);
        const bytes = await readBoundedRegularFile(absolute, dependencies, metadata);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
          throw new SnapshotCaptureError('limit', 'SOURCE exceeds 10 MiB', path);
        }
        await assertCanonical(logicalRoot, canonicalRoot, absolute, realpathPath);
        entries.push({ path, kind: 'file' });
        files.push({ path, bytes });
      } else {
        throw new SnapshotCaptureError('security', 'SOURCE contains a link or special file', path);
      }
    }
    const after = await lstatPath(directory);
    if (after.kind !== 'directory' || !sameIdentity(before, after)) {
      throw new SnapshotCaptureError(
        'security',
        'source directory changed during traversal',
        directory,
      );
    }
    await assertCanonical(logicalRoot, canonicalRoot, directory, realpathPath);
  };

  await visit(logicalRoot, rootBefore);
  const rootAfter = await lstatPath(logicalRoot);
  if (rootAfter.kind !== 'directory' || !sameIdentity(rootBefore, rootAfter)) {
    throw new SnapshotCaptureError('security', 'SOURCE root changed during traversal', root);
  }
  await assertCanonical(logicalRoot, canonicalRoot, logicalRoot, realpathPath);
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  assertPortableSnapshotEntries(entries);
  return { entries, files };
}
