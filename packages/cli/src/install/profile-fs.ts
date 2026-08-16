import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { InstallProfileError } from './profile-common.js';

type BigStats = BigIntStats;

export interface ProfileReadHooks {
  /** Test seam for deterministic lstat-to-open replacement mutants. */
  afterFileLstat?(path: string): Promise<void>;
  /** Test seam for deterministic pathname replacement after the handle is open. */
  afterFileOpen?(path: string): Promise<void>;
  /** Test seam for deterministic in-place modification after bytes are read. */
  afterFileRead?(path: string): Promise<void>;
  /** Test seam for deterministic directory replacement mutants. */
  afterDirectoryLstat?(path: string): Promise<void>;
}

export interface AtomicFile {
  bytes: Buffer;
  identity: string;
}

export interface SecureDirectory {
  canonical: string;
  identity: string;
}

function identity(metadata: { dev: bigint; ino: bigint }): string {
  return `${metadata.dev}:${metadata.ino}`;
}

function sameIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContentSnapshot(left: BigStats, right: BigStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function changed(path: string): InstallProfileError {
  return new InstallProfileError(
    'E_PROFILE_FILE_CHANGED',
    `文件在安全读取期间发生替换或修改：${path}`,
    path,
  );
}

/** Read from one handle and prove the lstat path still names that same ordinary file. */
export async function readAtomicFile(
  path: string,
  code: string,
  hooks: ProfileReadHooks = {},
): Promise<AtomicFile> {
  let before: BigStats;
  try {
    before = (await lstat(path, { bigint: true })) as BigStats;
  } catch {
    throw new InstallProfileError(code, `缺少必须文件：${path}`, path);
  }
  if (!before.isFile() || before.isSymbolicLink())
    throw new InstallProfileError(code, `拒绝 symlink 或非普通文件：${path}`, path);
  await hooks.afterFileLstat?.(path);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw changed(path);
  }
  try {
    const opened = (await handle.stat({ bigint: true })) as BigStats;
    if (!opened.isFile() || !sameIdentity(before, opened)) throw changed(path);
    await hooks.afterFileOpen?.(path);
    const current = (await lstat(path, { bigint: true })) as BigStats;
    if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current))
      throw changed(path);
    const bytes = await handle.readFile();
    await hooks.afterFileRead?.(path);
    const after = (await handle.stat({ bigint: true })) as BigStats;
    if (!sameContentSnapshot(opened, after)) throw changed(path);
    return { bytes, identity: identity(opened) };
  } finally {
    await handle.close();
  }
}

export async function inspectSecureDirectory(
  path: string,
  hooks: ProfileReadHooks = {},
): Promise<SecureDirectory | undefined> {
  let before: BigStats;
  try {
    before = (await lstat(path, { bigint: true })) as BigStats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new InstallProfileError(
      'E_PLUGIN_PATH_ALIAS',
      `拒绝 symlink、junction、reparse point 或非目录路径：${path}`,
      path,
    );
  await hooks.afterDirectoryLstat?.(path);
  let canonical: string;
  let current: BigStats;
  try {
    canonical = await realpath(path);
    current = (await lstat(path, { bigint: true })) as BigStats;
  } catch {
    throw changed(path);
  }
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(before, current))
    throw changed(path);
  return { canonical, identity: identity(current) };
}

export async function requireSecureDirectory(
  path: string,
  hooks: ProfileReadHooks = {},
): Promise<SecureDirectory> {
  const directory = await inspectSecureDirectory(path, hooks);
  if (directory === undefined)
    throw new InstallProfileError('E_PLUGIN_PATH_ALIAS', `目录不存在：${path}`, path);
  return directory;
}

function within(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Check every ancestor and the final file against the package's canonical root. */
export async function readConfinedAtomicFile(
  root: string,
  relativePath: string,
  code: string,
  hooks: ProfileReadHooks = {},
): Promise<AtomicFile> {
  const rootDirectory = await requireSecureDirectory(root, hooks);
  const segments = relativePath.split('/');
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    const directory = await requireSecureDirectory(cursor, hooks);
    if (!within(rootDirectory.canonical, directory.canonical))
      throw new InstallProfileError(
        'E_PLUGIN_PATH_ALIAS',
        'bundle patch 祖先逃逸插件目录。',
        cursor,
      );
  }
  const path = join(root, ...segments);
  const file = await readAtomicFile(path, code, hooks);
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw changed(path);
  }
  if (!within(rootDirectory.canonical, canonical))
    throw new InstallProfileError('E_PLUGIN_PATH_ALIAS', 'bundle patch 逃逸插件目录。', path);
  return file;
}
