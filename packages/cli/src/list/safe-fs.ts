import { type BigIntStats, constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

type BigStats = BigIntStats;

export interface SafePathHooks {
  afterFileLstat?(path: string): Promise<void>;
  afterFileOpen?(path: string): Promise<void>;
  afterFileRead?(path: string): Promise<void>;
  afterFileChunk?(path: string, bytesRead: number): Promise<void>;
  afterFileSnapshot?(path: string): Promise<void>;
  afterDirectoryLstat?(path: string): Promise<void>;
  /** Test seam for a directory whose entry set changes after enumeration. */
  afterDirectoryRead?(path: string): Promise<void>;
  /** Called after an entry set has been read and bound, for a later full-scan revalidation. */
  afterDirectorySnapshot?(
    binding: DirectoryBinding,
    entries: readonly Dirent<string>[],
  ): Promise<void>;
  /** Test seam for an ancestor that cannot be inspected during the reparse-point walk. */
  beforeAncestorLstat?(path: string): Promise<void>;
  /** Test seam for a file that changes into a special object in the lstat-to-open window. */
  openFile?(path: string, flags: number): Promise<Awaited<ReturnType<typeof open>>>;
  /** Test-only stand-in for O_NONBLOCK on platforms where Node exposes it as zero. */
  nonBlockingFlag?: number;
}

export type SafePathFailureKind = 'missing' | 'security' | 'io' | 'limit' | 'changed';

export interface SafePathFailure {
  ok: false;
  kind: SafePathFailureKind;
  reason: string;
}

export type SafePathResult<T> = { ok: true; value: T } | SafePathFailure;

interface DirectoryIdentity {
  path: string;
  canonical: string;
  identity: string;
}

export interface DirectoryBinding {
  rootPath: string;
  rootCanonical: string;
  entries: readonly [DirectoryIdentity, ...DirectoryIdentity[]];
}

export interface SafeText {
  text: string;
  identity: string;
}

export interface SafeBytes {
  bytes: Buffer;
  identity: string;
}

/** Immutable observation retained by a higher-level scan until it has the mutation lease. */
export interface SafeFileSnapshot {
  segments: readonly [string, ...string[]];
  identity: string;
  sha256: string;
  size: number;
  maximumBytes: number;
}

export const MAX_SAFE_TEXT_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

function identity(stats: { dev: bigint; ino: bigint; birthtimeNs: bigint }): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

export function sameIdentity(
  left: Pick<BigStats, 'dev' | 'ino' | 'birthtimeNs'>,
  right: Pick<BigStats, 'dev' | 'ino' | 'birthtimeNs'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function sameSnapshot(left: BigStats, right: BigStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function failure(error: unknown, path: string): SafePathFailure {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return { ok: false, kind: 'missing', reason: `路径不存在：${path}` };
  if (code === 'ENOTDIR' || code === 'ELOOP' || error instanceof TypeError)
    return { ok: false, kind: 'security', reason: `路径包含不安全祖先：${path}` };
  return { ok: false, kind: 'io', reason: `路径不可读取：${path}` };
}

function changed(path: string): SafePathFailure {
  return { ok: false, kind: 'security', reason: `路径在安全读取期间被替换：${path}` };
}

function directoryEntriesChanged(path: string): SafePathFailure {
  return {
    ok: false,
    kind: 'changed',
    reason: `directory entries changed during stable enumeration: ${path}`,
  };
}

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  hooks: SafePathHooks,
  maximumBytes: number,
): Promise<SafePathResult<Buffer>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumBytes)
      return { ok: false, kind: 'limit', reason: `file exceeds its safe read limit: ${path}` };
    chunks.push(chunk.subarray(0, bytesRead));
    await hooks.afterFileChunk?.(path, total);
  }
  return { ok: true, value: Buffer.concat(chunks, total) };
}

function within(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function inspectDirectory(
  path: string,
  hooks: SafePathHooks,
): Promise<SafePathResult<DirectoryIdentity>> {
  let before: BigStats;
  try {
    before = (await lstat(path, { bigint: true })) as BigStats;
  } catch (error) {
    return failure(error, path);
  }
  if (!before.isDirectory() || before.isSymbolicLink())
    return { ok: false, kind: 'security', reason: `拒绝 symlink、junction 或非目录：${path}` };
  await hooks.afterDirectoryLstat?.(path);
  try {
    const canonical = await realpath(path);
    const after = (await lstat(path, { bigint: true })) as BigStats;
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(before, after))
      return changed(path);
    return { ok: true, value: { path, canonical, identity: identity(after) } };
  } catch {
    return changed(path);
  }
}

/**
 * The nearest ancestor of `path` that is a symlink, junction or other reparse point, or
 * undefined when the whole chain to the drive root is ordinary directories.
 *
 * Ancestors are inspected directly rather than by comparing `path` against its realpath.
 * That comparison cannot answer this question on Windows: an 8.3 alias
 * (`C:\Users\RUNNER~1\AppData\Local\Temp`) or a differently-cased spelling names exactly
 * the same directory through no link at all, yet compares unequal — which refused a
 * perfectly ordinary home as though it were under attack. An ancestor we cannot inspect
 * is one we cannot vouch for, so it counts as linked.
 */
export async function linkedAncestor(
  path: string,
  hooks: SafePathHooks = {},
): Promise<string | undefined> {
  for (let current = dirname(resolve(path)); ; ) {
    let stats: BigStats;
    try {
      await hooks.beforeAncestorLstat?.(current);
      stats = (await lstat(current, { bigint: true })) as BigStats;
    } catch {
      return current;
    }
    if (stats.isSymbolicLink()) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function bindSecureRoot(
  rootPath: string,
  hooks: SafePathHooks = {},
): Promise<SafePathResult<DirectoryBinding>> {
  if (!isAbsolute(rootPath))
    return { ok: false, kind: 'security', reason: `安全根目录必须是绝对路径：${rootPath}` };
  const root = await inspectDirectory(rootPath, hooks);
  if (!root.ok) return root;
  const linked = await linkedAncestor(rootPath, hooks);
  if (linked !== undefined)
    return {
      ok: false,
      kind: 'security',
      reason: `安全根目录含 symlink 祖先：${linked}`,
    };
  return {
    ok: true,
    value: { rootPath, rootCanonical: root.value.canonical, entries: [root.value] },
  };
}

async function appendDirectories(
  root: DirectoryBinding,
  segments: readonly string[],
  hooks: SafePathHooks,
): Promise<SafePathResult<DirectoryBinding>> {
  const entries: DirectoryIdentity[] = [];
  for (const expected of root.entries) {
    const current = await inspectDirectory(expected.path, hooks);
    if (!current.ok) return changed(expected.path);
    if (
      current.value.identity !== expected.identity ||
      current.value.canonical !== expected.canonical
    )
      return changed(expected.path);
    entries.push(current.value);
  }
  // Re-run the ancestor walk rather than compare spellings: an ancestor that became a
  // junction since the bind must be caught, but an 8.3 alias never was one.
  if ((await linkedAncestor(root.rootPath, hooks)) !== undefined) return changed(root.rootPath);
  let cursor = (entries.at(-1) as DirectoryIdentity).path;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const current = await inspectDirectory(cursor, hooks);
    if (!current.ok) return current;
    if (!within(root.rootCanonical, current.value.canonical))
      return { ok: false, kind: 'security', reason: `目录逃逸安全根：${cursor}` };
    entries.push(current.value);
  }
  return {
    ok: true,
    value: { ...root, entries: entries as [DirectoryIdentity, ...DirectoryIdentity[]] },
  };
}

export function bindDirectory(
  root: DirectoryBinding,
  segments: readonly string[],
  hooks: SafePathHooks = {},
): Promise<SafePathResult<DirectoryBinding>> {
  return appendDirectories(root, segments, hooks);
}

export async function revalidateDirectory(
  binding: DirectoryBinding,
  hooks: SafePathHooks = {},
): Promise<SafePathResult<void>> {
  const current = await appendDirectories(binding, [], hooks);
  return current.ok ? { ok: true, value: undefined } : current;
}

export async function readDirectory(
  root: DirectoryBinding,
  segments: readonly string[],
  hooks: SafePathHooks = {},
): Promise<SafePathResult<Dirent<string>[]>> {
  const directory = await appendDirectories(root, segments, hooks);
  if (!directory.ok) return directory;
  const path = (directory.value.entries.at(-1) as DirectoryIdentity).path;
  try {
    const entries = await readdir(path, { encoding: 'utf8', withFileTypes: true });
    await hooks.afterDirectoryRead?.(path);
    const afterEntries = await readdir(path, { encoding: 'utf8', withFileTypes: true });
    if (!sameDirectoryEntries(entries, afterEntries)) return directoryEntriesChanged(path);
    const current = await revalidateDirectory(directory.value, hooks);
    if (!current.ok) return current;
    await hooks.afterDirectorySnapshot?.(directory.value, entries);
    return { ok: true, value: entries };
  } catch (error) {
    return failure(error, path);
  }
}

/** Re-read one enumerated directory and require exactly the same entry set and stable binding. */
export async function revalidateDirectoryEntries(
  binding: DirectoryBinding,
  expected: readonly Dirent<string>[],
  hooks: SafePathHooks = {},
): Promise<SafePathResult<void>> {
  const path = (binding.entries.at(-1) as DirectoryIdentity).path;
  try {
    const entries = await readdir(path, { encoding: 'utf8', withFileTypes: true });
    if (!sameDirectoryEntries(expected, entries)) return directoryEntriesChanged(path);
    return revalidateDirectory(binding, hooks);
  } catch (error) {
    return failure(error, path);
  }
}

function directoryEntryType(entry: Dirent<string>): string {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

/**
 * Directory identity alone does not change when a concurrent writer adds or removes a child.
 * Compare the complete name/type set so callers never plan from a partial generation/CAS view.
 */
function sameDirectoryEntries(
  left: readonly Dirent<string>[],
  right: readonly Dirent<string>[],
): boolean {
  if (left.length !== right.length) return false;
  const normalize = (entries: readonly Dirent<string>[]) =>
    entries
      .map((entry) => `${directoryEntryType(entry)}\u0000${entry.name}`)
      .sort((first, second) => first.localeCompare(second, 'en'));
  const before = normalize(left);
  const after = normalize(right);
  return before.every((entry, index) => entry === after[index]);
}

export async function readBytes(
  root: DirectoryBinding,
  segments: readonly [string, ...string[]],
  hooks: SafePathHooks = {},
  maximumBytes = MAX_SAFE_TEXT_BYTES,
): Promise<SafePathResult<SafeBytes>> {
  const parents = await appendDirectories(root, segments.slice(0, -1), hooks);
  if (!parents.ok) return parents;
  const path = join(
    (parents.value.entries.at(-1) as DirectoryIdentity).path,
    segments[segments.length - 1] as string,
  );
  let before: BigStats;
  try {
    before = (await lstat(path, { bigint: true })) as BigStats;
  } catch (error) {
    return failure(error, path);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
    return { ok: false, kind: 'security', reason: `拒绝 symlink 或非普通文件：${path}` };
  if (before.size > BigInt(maximumBytes)) {
    return {
      ok: false,
      kind: 'limit',
      reason: `file exceeds its safe read limit: ${path}`,
    };
  }
  await hooks.afterFileLstat?.(path);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    const readFlags =
      constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (hooks.nonBlockingFlag ?? constants.O_NONBLOCK ?? 0);
    handle = await (hooks.openFile === undefined
      ? open(path, readFlags)
      : hooks.openFile(path, readFlags));
  } catch {
    return changed(path);
  }
  try {
    const opened = (await handle.stat({ bigint: true })) as BigStats;
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened))
      return changed(path);
    await hooks.afterFileOpen?.(path);
    const named = (await lstat(path, { bigint: true })) as BigStats;
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.nlink !== 1n ||
      !sameIdentity(opened, named)
    )
      return changed(path);
    const bytes = await readBounded(handle, path, hooks, maximumBytes);
    if (!bytes.ok) return bytes;
    await hooks.afterFileRead?.(path);
    const after = (await handle.stat({ bigint: true })) as BigStats;
    if (!sameSnapshot(opened, after)) return changed(path);
    await hooks.afterFileSnapshot?.(path);
    const finalPath = (await lstat(path, { bigint: true })) as BigStats;
    if (
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      finalPath.nlink !== 1n ||
      !sameIdentity(after, finalPath)
    )
      return changed(path);
    if (!sameSnapshot(after, finalPath))
      return {
        ok: false,
        kind: 'changed',
        reason: `file changed after its bounded snapshot: ${path}`,
      };
    const directories = await revalidateDirectory(parents.value, hooks);
    if (!directories.ok) return directories;
    return {
      ok: true,
      value: { bytes: bytes.value, identity: identity(opened) },
    };
  } catch (error) {
    const result = failure(error, path);
    return result.kind === 'missing' ? changed(path) : result;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Re-open and compare every component of a prior bounded file observation before mutation. */
export async function revalidateFileSnapshot(
  root: DirectoryBinding,
  snapshot: SafeFileSnapshot,
  hooks: SafePathHooks = {},
): Promise<SafePathResult<void>> {
  const current = await readBytes(root, snapshot.segments, hooks, snapshot.maximumBytes);
  if (!current.ok) return current;
  if (
    current.value.identity !== snapshot.identity ||
    current.value.bytes.byteLength !== snapshot.size ||
    sha256(current.value.bytes) !== snapshot.sha256
  )
    return {
      ok: false,
      kind: 'changed',
      reason: 'file content changed after it was captured for a managed-state scan.',
    };
  return { ok: true, value: undefined };
}

export async function readText(
  root: DirectoryBinding,
  segments: readonly [string, ...string[]],
  hooks: SafePathHooks = {},
  maximumBytes = MAX_SAFE_TEXT_BYTES,
): Promise<SafePathResult<SafeText>> {
  const bytes = await readBytes(root, segments, hooks, maximumBytes);
  if (!bytes.ok) return bytes;
  const text = bytes.value.bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes.value.bytes)) {
    return { ok: false, kind: 'security', reason: 'file is not valid UTF-8' };
  }
  return { ok: true, value: { text, identity: bytes.value.identity } };
}

import { createHash } from 'node:crypto';
