import { type BigIntStats, constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

type BigStats = BigIntStats;

export interface SafePathHooks {
  afterFileLstat?(path: string): Promise<void>;
  afterFileOpen?(path: string): Promise<void>;
  afterFileRead?(path: string): Promise<void>;
  afterFileChunk?(path: string, bytesRead: number): Promise<void>;
  afterFileSnapshot?(path: string): Promise<void>;
  afterDirectoryLstat?(path: string): Promise<void>;
}

export type SafePathFailureKind = 'missing' | 'security' | 'io';

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

export const MAX_SAFE_TEXT_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function identity(stats: { dev: bigint; ino: bigint }): string {
  return `${stats.dev}:${stats.ino}`;
}

function sameIdentity(left: BigStats, right: BigStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigStats, right: BigStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
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

async function readBounded(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  hooks: SafePathHooks,
): Promise<SafePathResult<Buffer>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_SAFE_TEXT_BYTES)
      return { ok: false, kind: 'io', reason: `文本文件超过 1 MiB 安全上限：${path}` };
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

export async function bindSecureRoot(
  rootPath: string,
  hooks: SafePathHooks = {},
): Promise<SafePathResult<DirectoryBinding>> {
  if (!isAbsolute(rootPath))
    return { ok: false, kind: 'security', reason: `安全根目录必须是绝对路径：${rootPath}` };
  const root = await inspectDirectory(rootPath, hooks);
  if (!root.ok) return root;
  if (relative(resolve(rootPath), resolve(root.value.canonical)) !== '')
    return { ok: false, kind: 'security', reason: `安全根目录含 symlink 祖先：${rootPath}` };
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
    if (current.value.identity !== expected.identity) return changed(expected.path);
    entries.push(current.value);
  }
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
    const current = await revalidateDirectory(directory.value, hooks);
    return current.ok ? { ok: true, value: entries } : current;
  } catch (error) {
    return failure(error, path);
  }
}

export async function readText(
  root: DirectoryBinding,
  segments: readonly [string, ...string[]],
  hooks: SafePathHooks = {},
): Promise<SafePathResult<SafeText>> {
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
  if (!before.isFile() || before.isSymbolicLink())
    return { ok: false, kind: 'security', reason: `拒绝 symlink 或非普通文件：${path}` };
  await hooks.afterFileLstat?.(path);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, READ_FLAGS);
  } catch {
    return changed(path);
  }
  try {
    const opened = (await handle.stat({ bigint: true })) as BigStats;
    if (!opened.isFile() || !sameIdentity(before, opened)) return changed(path);
    await hooks.afterFileOpen?.(path);
    const named = (await lstat(path, { bigint: true })) as BigStats;
    if (!named.isFile() || named.isSymbolicLink() || !sameIdentity(opened, named))
      return changed(path);
    const bytes = await readBounded(handle, path, hooks);
    if (!bytes.ok) return bytes;
    await hooks.afterFileRead?.(path);
    const after = (await handle.stat({ bigint: true })) as BigStats;
    if (!sameSnapshot(opened, after)) return changed(path);
    await hooks.afterFileSnapshot?.(path);
    const finalPath = (await lstat(path, { bigint: true })) as BigStats;
    if (!finalPath.isFile() || finalPath.isSymbolicLink() || !sameIdentity(after, finalPath))
      return changed(path);
    const directories = await revalidateDirectory(parents.value, hooks);
    if (!directories.ok) return directories;
    return {
      ok: true,
      value: { text: bytes.value.toString('utf8'), identity: identity(opened) },
    };
  } catch (error) {
    const result = failure(error, path);
    return result.kind === 'missing' ? changed(path) : result;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
