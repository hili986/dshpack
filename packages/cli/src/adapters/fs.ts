import { randomBytes } from 'node:crypto';
import { type FileHandle, lstat, mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface FileSystemAdapter {
  ensureDirectory(path: string): Promise<void>;
  createDirectoryExclusive(path: string): Promise<boolean>;
  pathExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  atomicWriteText(path: string, contents: string): Promise<void>;
  writeText(path: string, contents: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

export interface AtomicWriteOptions {
  mode: number;
  dirMode?: number;
}

/** Rename completed, but persisting one of its directory entries failed. */
export class DurableRenameAfterMoveError extends Error {
  constructor(
    readonly source: string,
    readonly destination: string,
  ) {
    super('rename completed but directory durability confirmation failed.');
    this.name = 'DurableRenameAfterMoveError';
  }
}

/** Unlink completed, but persisting its parent directory entry failed. */
export class DurableRemoveAfterUnlinkError extends Error {
  constructor(readonly path: string) {
    super('unlink completed but parent directory durability confirmation failed.');
    this.name = 'DurableRemoveAfterUnlinkError';
  }
}

/** Directory creation succeeded, but persisting its parent entry failed. */
export class DurableDirectoryCreateError extends Error {
  constructor(readonly path: string) {
    super('directory creation completed but parent durability confirmation failed.');
    this.name = 'DurableDirectoryCreateError';
  }
}

/** Directory removal completed, but persisting its parent entry failed. */
export class DurableDirectoryRemoveError extends Error {
  constructor(readonly path: string) {
    super('directory removal completed but parent durability confirmation failed.');
    this.name = 'DurableDirectoryRemoveError';
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EISDIR' || code === 'EINVAL' || code === 'EPERM' || code === 'ENOTSUP';
}

export async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose a portable Node API for opening/fsyncing directories.
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

/** Rename a state entry and durably persist both affected directory entries. */
export async function renameDurable(source: string, destination: string): Promise<void> {
  await rename(source, destination);
  try {
    const destinationParent = dirname(destination);
    const sourceParent = dirname(source);
    await syncDirectory(destinationParent);
    if (sourceParent !== destinationParent) await syncDirectory(sourceParent);
  } catch {
    throw new DurableRenameAfterMoveError(source, destination);
  }
}

/** Remove a quarantined payload only after its parent directory entry is durably updated. */
export async function removeFileDurable(path: string): Promise<void> {
  await rm(path);
  try {
    await syncDirectory(dirname(path));
  } catch {
    throw new DurableRemoveAfterUnlinkError(path);
  }
}

/** Remove an empty transaction-owned directory and durably persist its parent entry. */
export async function removeDirectoryDurable(path: string): Promise<void> {
  await rmdir(path);
  try {
    await syncDirectory(dirname(path));
  } catch {
    throw new DurableDirectoryRemoveError(path);
  }
}

/** Atomically and durably replace a file through an exclusive sibling temp file. */
export async function writeFileAtomic(
  filename: string,
  contents: string,
  options: AtomicWriteOptions,
): Promise<void> {
  const parent = dirname(filename);
  await mkdir(parent, {
    recursive: true,
    ...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
  });
  const temporary = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, 'wx', options.mode);
    await handle.writeFile(contents, 'utf8');

    // 我方更严，非复刻官方 (stricter by design, not an official-behavior replica):
    // official atomic-write leaves fsync out of scope; user settings justify the extra durability.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(parent);
    await rename(temporary, filename);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Exclusively create durable binary state without replacing an existing content-addressed file. */
export async function writeFileExclusive(
  filename: string,
  contents: Uint8Array,
  options: AtomicWriteOptions,
): Promise<boolean> {
  const parent = dirname(filename);
  await mkdir(parent, {
    recursive: true,
    ...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
  });
  let handle: FileHandle | undefined;
  try {
    handle = await open(filename, 'wx', options.mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(parent);
  return true;
}

/** Secure default adapter for user-private text files. */
const atomicWriteText = (path: string, contents: string): Promise<void> =>
  writeFileAtomic(path, contents, { mode: 0o600, dirMode: 0o700 });

export const nodeFileSystemAdapter: FileSystemAdapter = {
  ensureDirectory: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  createDirectoryExclusive: async (path) => {
    let created = false;
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
      await syncDirectory(dirname(path));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
      if (created) throw new DurableDirectoryCreateError(path);
      throw error;
    }
  },
  pathExists: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
      throw error;
    }
  },
  readText: (path) => readFile(path, 'utf8'),
  atomicWriteText,
  writeText: atomicWriteText,
  rename: renameDurable,
};
