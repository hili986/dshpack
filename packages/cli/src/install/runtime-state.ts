import { createHash, type Hash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { digestTargetBeforeState } from './build-plan.js';
import type { CaptureInstallTargetInput, InstallTargetCapture } from './runtime-types.js';
import type { InstallPathBeforeState } from './types.js';

type BigStats = Awaited<ReturnType<typeof lstat>> & {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  nlink: bigint;
};

const READ_CHUNK = 64 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;

export class InstallTargetStateError extends Error {
  readonly code = 'E_TARGET_PATH';

  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'InstallTargetStateError';
  }
}

function sameSnapshot(left: BigStats, right: BigStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function within(root: string, path: string): boolean {
  const child = relative(root, resolve(path));
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function safeSegments(relativePath: string): string[] {
  const segments = relativePath.split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('\\') ||
        /\p{Cc}/u.test(segment),
    )
  )
    throw new InstallTargetStateError('目标相对路径不安全。', relativePath);
  return segments;
}

async function rootIdentity(dshHome: string): Promise<{ canonical: string; stats: BigStats }> {
  if (!isAbsolute(dshHome)) throw new InstallTargetStateError('DSH_HOME 必须是绝对路径。', dshHome);
  const stats = (await lstat(dshHome, { bigint: true })) as BigStats;
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new InstallTargetStateError('DSH_HOME 必须是普通目录。', dshHome);
  const canonical = await realpath(dshHome);
  if (relative(resolve(dshHome), resolve(canonical)) !== '')
    throw new InstallTargetStateError('DSH_HOME 含 symlink/junction 祖先。', dshHome);
  return { canonical, stats };
}

async function targetStats(
  dshHome: string,
  rootCanonical: string,
  relativePath: string,
): Promise<{ path: string; stats?: BigStats }> {
  let cursor = dshHome;
  const segments = safeSegments(relativePath);
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    let stats: BigStats;
    try {
      stats = (await lstat(cursor, { bigint: true })) as BigStats;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: cursor };
      throw error;
    }
    if (stats.isSymbolicLink())
      throw new InstallTargetStateError('目标路径含 symlink/junction。', cursor);
    if (index < segments.length - 1 && !stats.isDirectory())
      throw new InstallTargetStateError('目标祖先不是目录。', cursor);
    const canonical = await realpath(cursor);
    if (!within(rootCanonical, canonical))
      throw new InstallTargetStateError('目标路径逃逸 DSH_HOME。', cursor);
    if (index === segments.length - 1) return { path: cursor, stats };
  }
  return { path: cursor };
}

async function hashFile(
  path: string,
  relativePath: string,
  before: BigStats,
  hash: Hash,
  collect: boolean,
): Promise<string | undefined> {
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1n)
    throw new InstallTargetStateError('目标文件不是独占普通文件。', path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    const opened = (await handle.stat({ bigint: true })) as BigStats;
    if (!sameSnapshot(before, opened))
      throw new InstallTargetStateError('目标文件在打开前变化。', path);
    hash.update(`F\0${relativePath}\0${opened.size}\0`);
    for (;;) {
      const chunk = Buffer.allocUnsafe(READ_CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      total += bytesRead;
      if (collect && total > MAX_SETTINGS_BYTES)
        throw new InstallTargetStateError('settings.yaml 超过 1 MiB 上限。', path);
      hash.update(bytes);
      if (collect) chunks.push(bytes);
    }
    const after = (await handle.stat({ bigint: true })) as BigStats;
    const named = (await lstat(path, { bigint: true })) as BigStats;
    if (!sameSnapshot(opened, after) || !sameSnapshot(after, named))
      throw new InstallTargetStateError('目标文件在读取期间变化。', path);
  } finally {
    await handle.close();
  }
  return collect ? Buffer.concat(chunks, total).toString('utf8') : undefined;
}

async function hashDirectory(root: string, directory: string, hash: Hash): Promise<void> {
  const before = (await lstat(directory, { bigint: true })) as BigStats;
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new InstallTargetStateError('目标不是普通目录。', directory);
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  );
  hash.update(`D\0${relative(root, directory).replaceAll('\\', '/')}\0`);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    const stats = (await lstat(path, { bigint: true })) as BigStats;
    if (stats.isDirectory() && !stats.isSymbolicLink()) await hashDirectory(root, path, hash);
    else if (stats.isFile() && !stats.isSymbolicLink())
      await hashFile(path, relativePath, stats, hash, false);
    else throw new InstallTargetStateError('目标目录含不安全条目。', path);
  }
  const after = (await lstat(directory, { bigint: true })) as BigStats;
  if (!sameSnapshot(before, after))
    throw new InstallTargetStateError('目标目录在读取期间变化。', directory);
}

async function directoryState(
  dshHome: string,
  rootCanonical: string,
  relativePath: string,
): Promise<InstallPathBeforeState> {
  const target = await targetStats(dshHome, rootCanonical, relativePath);
  if (target.stats === undefined) return { path: relativePath, state: 'absent' };
  if (!target.stats.isDirectory())
    throw new InstallTargetStateError('托管目标必须是目录。', target.path);
  const hash = createHash('sha256');
  await hashDirectory(target.path, target.path, hash);
  return { path: relativePath, state: 'present', sha256: `sha256-${hash.digest('base64url')}` };
}

async function settingsState(
  dshHome: string,
  rootCanonical: string,
): Promise<{ state: InstallPathBeforeState; document?: string }> {
  const relativePath = 'settings.yaml';
  const target = await targetStats(dshHome, rootCanonical, relativePath);
  if (target.stats === undefined) return { state: { path: relativePath, state: 'absent' } };
  const hash = createHash('sha256');
  const document = await hashFile(target.path, relativePath, target.stats, hash, true);
  return {
    state: { path: relativePath, state: 'present', sha256: `sha256-${hash.digest('base64url')}` },
    document: document as string,
  };
}

export async function captureInstallTargetState(
  input: CaptureInstallTargetInput,
): Promise<InstallTargetCapture> {
  const root = await rootIdentity(input.dshHome);
  const profile = await directoryState(input.dshHome, root.canonical, `profiles/${input.profile}`);
  const skills = await Promise.all(
    input.skills.map((path) => directoryState(input.dshHome, root.canonical, path)),
  );
  const presets = await Promise.all(
    input.presets.map((path) => directoryState(input.dshHome, root.canonical, path)),
  );
  const settings = await settingsState(input.dshHome, root.canonical);
  const externalDefaultPreset =
    input.externalDefaultPreset === undefined
      ? undefined
      : await directoryState(input.dshHome, root.canonical, input.externalDefaultPreset);
  const state = {
    profile,
    skills,
    presets,
    settings: settings.state,
    ...(externalDefaultPreset === undefined ? {} : { externalDefaultPreset }),
  };
  return {
    state,
    digest: digestTargetBeforeState(state),
    ...(settings.document === undefined ? {} : { settingsDocument: settings.document }),
  };
}
