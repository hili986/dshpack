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
// Raw-header scanning is bounded before tar parsing to cap gzip expansion work. 256 MiB admits
// ordinary GitHub codeload archives while retaining a finite DoS boundary.
export const MAX_RAW_HEADER_BYTES = 256 * 1024 * 1024;

type ArchiveError = (code: string, message: string) => Error;

export interface GitHubArchiveExpectation {
  commit: string;
}

interface ArchiveState {
  diagnostics: Diagnostic[];
  githubRootName: string | undefined;
}

interface DeployableArchiveEntry {
  readonly path: string;
  readonly size: number;
  readonly type: 'Directory' | 'File' | 'OldFile';
}

interface ArchiveInspection {
  diagnostics: readonly Diagnostic[];
  githubRoot: string | undefined;
  selectedPaths?: ReadonlySet<string>;
}

export interface ArchivePreflightOptions {
  readonly rawHeaderMaxBytes?: number;
  /** Compose-only projection for a conventional `.agents/skills/<id>/SKILL.md` source. */
  readonly selectiveComposeSkills?: boolean;
}

export type RawHeaderSafety =
  | { readonly safe: true }
  | {
      readonly safe: false;
      readonly reason: 'cap';
      readonly expandedBytes: number;
      readonly maxExpandedBytes: number;
    }
  | { readonly safe: false; readonly reason: 'unsafe' };

type MetadataHeaderType = 'g' | 'x' | 'X' | 'K' | 'L' | 'N';

type MetadataHeaderSafety =
  | { readonly safe: true; readonly types: readonly MetadataHeaderType[] }
  | {
      readonly safe: false;
      readonly reason: 'cap';
      readonly expandedBytes: number;
      readonly maxExpandedBytes: number;
    }
  | { readonly safe: false; readonly reason: 'unsafe' };

function dataAfterNul(block: Buffer, offset: number, length: number): boolean {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return nul >= 0 && field.subarray(nul + 1).some((byte) => byte !== 0);
}

function inspectRawHeaderBlock(block: Buffer, remaining: number): number | undefined {
  if (remaining > 0) return remaining - 512;
  if (block.every((byte) => byte === 0)) return 0;
  if (dataAfterNul(block, 0, 100) || dataAfterNul(block, 345, 155)) return undefined;
  const sizeField = block.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
  if (!/^[0-7]+$/u.test(sizeField)) return undefined;
  return Math.ceil(Number.parseInt(sizeField, 8) / 512) * 512;
}

export async function rawHeadersSafe(
  filename: string,
  maxExpandedBytes = MAX_RAW_HEADER_BYTES,
): Promise<RawHeaderSafety> {
  let tail = Buffer.alloc(0);
  let remaining = 0;
  let expanded = 0;
  try {
    const stream = createReadStream(filename).pipe(createGunzip());
    for await (const value of stream) {
      const chunk = Buffer.from(value);
      expanded += chunk.byteLength;
      if (expanded > maxExpandedBytes)
        return { safe: false, reason: 'cap', expandedBytes: expanded, maxExpandedBytes };
      let offset = 0;
      if (tail.byteLength > 0) {
        const needed = 512 - tail.byteLength;
        if (chunk.byteLength < needed) {
          const nextTail = Buffer.allocUnsafe(tail.byteLength + chunk.byteLength);
          tail.copy(nextTail);
          chunk.copy(nextTail, tail.byteLength);
          tail = nextTail;
          continue;
        }
        const block = Buffer.allocUnsafe(512);
        tail.copy(block);
        chunk.copy(block, tail.byteLength, 0, needed);
        const nextRemaining = inspectRawHeaderBlock(block, remaining);
        if (nextRemaining === undefined) return { safe: false, reason: 'unsafe' };
        remaining = nextRemaining;
        tail = Buffer.alloc(0);
        offset = needed;
      }
      while (offset + 512 <= chunk.byteLength) {
        const nextRemaining = inspectRawHeaderBlock(
          chunk.subarray(offset, offset + 512),
          remaining,
        );
        if (nextRemaining === undefined) return { safe: false, reason: 'unsafe' };
        remaining = nextRemaining;
        offset += 512;
      }
      if (offset < chunk.byteLength) tail = Buffer.from(chunk.subarray(offset));
    }
  } catch {
    return { safe: false, reason: 'unsafe' };
  }
  return tail.byteLength === 0 && remaining === 0
    ? { safe: true }
    : { safe: false, reason: 'unsafe' };
}

function metadataHeaderType(block: Buffer): MetadataHeaderType | undefined {
  const type = block.toString('ascii', 156, 157);
  return type === 'g' ||
    type === 'x' ||
    type === 'X' ||
    type === 'K' ||
    type === 'L' ||
    type === 'N'
    ? type
    : undefined;
}

async function metadataHeaderTypes(
  filename: string,
  maxExpandedBytes = MAX_RAW_HEADER_BYTES,
): Promise<MetadataHeaderSafety> {
  let tail = Buffer.alloc(0);
  let remaining = 0;
  let expanded = 0;
  const types: MetadataHeaderType[] = [];
  const inspect = (block: Buffer): boolean => {
    const type = remaining === 0 ? metadataHeaderType(block) : undefined;
    const nextRemaining = inspectRawHeaderBlock(block, remaining);
    if (nextRemaining === undefined) return false;
    if (type !== undefined) types.push(type);
    remaining = nextRemaining;
    return true;
  };
  try {
    const stream = createReadStream(filename).pipe(createGunzip());
    for await (const value of stream) {
      const chunk = Buffer.from(value);
      expanded += chunk.byteLength;
      if (expanded > maxExpandedBytes)
        return { safe: false, reason: 'cap', expandedBytes: expanded, maxExpandedBytes };
      let offset = 0;
      if (tail.byteLength > 0) {
        const needed = 512 - tail.byteLength;
        if (chunk.byteLength < needed) {
          const nextTail = Buffer.allocUnsafe(tail.byteLength + chunk.byteLength);
          tail.copy(nextTail);
          chunk.copy(nextTail, tail.byteLength);
          tail = nextTail;
          continue;
        }
        const block = Buffer.allocUnsafe(512);
        tail.copy(block);
        chunk.copy(block, tail.byteLength, 0, needed);
        if (!inspect(block)) return { safe: false, reason: 'unsafe' };
        tail = Buffer.alloc(0);
        offset = needed;
      }
      while (offset + 512 <= chunk.byteLength) {
        if (!inspect(chunk.subarray(offset, offset + 512)))
          return { safe: false, reason: 'unsafe' };
        offset += 512;
      }
      if (offset < chunk.byteLength) tail = Buffer.from(chunk.subarray(offset));
    }
  } catch {
    return { safe: false, reason: 'unsafe' };
  }
  return tail.byteLength === 0 && remaining === 0
    ? { safe: true, types }
    : { safe: false, reason: 'unsafe' };
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

/**
 * Fail-closed allowlist of per-entry PAX keys admitted from a pinned GitHub codeload archive.
 * Every key is either inert for our deployment semantics (times/ownership/mode/device numbers/
 * charset — live codeload even ships `comment` empty, so no per-entry pin is demanded), skipped
 * with non-regular entries (linkpath), or fully re-validated downstream: `path` becomes the
 * entry path and passes safeEntryPath's traversal/segment/collision checks, `size` desyncs the
 * strict parser if lied about. The provenance pin is the GLOBAL header's comment==commit,
 * enforced by the unchanged unsafeGlobal rule. Any key outside this set rejects the archive.
 */
const GITHUB_PAX_ALLOWLIST: ReadonlySet<string> = new Set([
  'atime',
  'charset',
  'comment',
  'ctime',
  'dev',
  'gid',
  'gname',
  'ino',
  'linkpath',
  'mode',
  'mtime',
  'nlink',
  'path',
  'size',
  'uid',
  'uname',
]);

export function acceptableGitHubPax(
  entry: ReadEntry,
  expectedGitHub: GitHubArchiveExpectation | undefined,
): boolean {
  const extended = entry.extended;
  if (expectedGitHub === undefined || extended === undefined) return false;
  // The provenance pin lives in the global header; node-tar attaches it to every subsequent
  // entry, so a pax-bearing entry without a matching global pin is refused.
  if (entry.globalExtended?.comment !== expectedGitHub.commit) return false;
  const contentKeys = Object.entries(extended)
    .filter(([key, value]) => key !== 'global' && value !== undefined)
    .map(([key]) => key);
  return contentKeys.every((key) => GITHUB_PAX_ALLOWLIST.has(key));
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

function selectiveSkippedDiagnostic(entries: number, bytes: number): Diagnostic {
  return {
    code: 'E_ARCHIVE_SELECTIVE_SKIPPED',
    severity: 'warning',
    message: `compose 约定来源跳过 ${entries} 个普通条目，共 ${bytes} bytes。`,
    hint: '这些条目不属于可组合的 skill 路径，未部署也未纳入凭据扫描。',
    evidence: 'local',
  };
}

interface DeploymentState {
  bytes: number;
  filePaths: Set<string>;
  parents: Set<string>;
  paths: Map<string, string>;
  terminals: Set<string>;
}

function deploymentState(): DeploymentState {
  return {
    bytes: 0,
    filePaths: new Set<string>(),
    parents: new Set<string>(),
    paths: new Map<string, string>(),
    terminals: new Set<string>(),
  };
}

function inspectArchiveStructure(
  entry: ReadEntry,
  state: ArchiveState,
  fail: ArchiveError,
  expectedGitHub?: GitHubArchiveExpectation,
  acceptedPax = acceptableGitHubPax(entry, expectedGitHub),
): DeployableArchiveEntry | undefined {
  const global = entry.globalExtended;
  const unsafeGlobal =
    global !== undefined &&
    (expectedGitHub === undefined ||
      global.comment !== expectedGitHub.commit ||
      Object.entries(global).some(
        ([key, value]) => value !== undefined && key !== 'global' && key !== 'comment',
      ));
  if ((entry.extended !== undefined && !acceptedPax) || unsafeGlobal) {
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
  if (expectedGitHub !== undefined && segments.length === 1 && entry.type !== 'Directory')
    throw fail('ARCHIVE_UNSAFE', 'GitHub codeload 顶层条目不是普通目录。');
  if (entry.type === 'Directory') {
    if (entry.size !== 0) throw fail('ARCHIVE_UNSAFE', '归档目录条目无效。');
    return { path, size: entry.size, type: 'Directory' };
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0)
    throw fail('ARCHIVE_LIMIT', '归档单文件超过 1 MiB 限制。');
  return { path, size: entry.size, type: entry.type === 'File' ? 'File' : 'OldFile' };
}

function validateDeploymentEntry(
  entry: DeployableArchiveEntry,
  state: DeploymentState,
  fail: ArchiveError,
): void {
  const segments = entry.path.split('/');
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
    return;
  }
  state.filePaths.add(leafCanonical);
  if (entry.size > MAX_FILE_BYTES) throw fail('ARCHIVE_LIMIT', '归档单文件超过 1 MiB 限制。');
  state.bytes += entry.size;
  if (state.bytes > MAX_TOTAL_BYTES) {
    throw fail('ARCHIVE_LIMIT', '归档超过总大小限制。');
  }
}

function relativeToGitHubRoot(path: string, githubRoot: string | undefined): string | undefined {
  if (githubRoot === undefined) return path;
  const prefix = `${githubRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function conventionalSkillSegments(
  entry: DeployableArchiveEntry,
  githubRoot: string | undefined,
): readonly string[] | undefined {
  const relative = relativeToGitHubRoot(entry.path, githubRoot);
  if (relative === undefined) return undefined;
  const segments = relative.split('/');
  return segments[0] === '.agents' &&
    segments[1] === 'skills' &&
    segments[2] !== undefined &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(segments[2])
    ? segments
    : undefined;
}

function isPackManifestEntry(
  entry: DeployableArchiveEntry,
  githubRoot: string | undefined,
): boolean {
  return entry.type !== 'Directory' && relativeToGitHubRoot(entry.path, githubRoot) === 'pack.yml';
}

function selectedConventionalEntry(
  entry: DeployableArchiveEntry,
  githubRoot: string | undefined,
): boolean {
  if (githubRoot !== undefined && entry.path === githubRoot) return true;
  const relative = relativeToGitHubRoot(entry.path, githubRoot);
  if (relative === '.agents' || relative === '.agents/skills') return true;
  const segments = conventionalSkillSegments(entry, githubRoot);
  return (
    (segments?.length === 3 && entry.type === 'Directory') ||
    (segments?.length === 4 && segments[3] === 'SKILL.md' && entry.type !== 'Directory')
  );
}

async function preflight(
  filename: string,
  fail: ArchiveError,
  expectedGitHub?: GitHubArchiveExpectation,
  options: ArchivePreflightOptions = {},
): Promise<ArchiveInspection> {
  const rawHeaderSafety = await rawHeadersSafe(filename, options.rawHeaderMaxBytes);
  if (!rawHeaderSafety.safe && rawHeaderSafety.reason === 'cap')
    throw fail(
      'E_ARCHIVE_PREFLIGHT_CAP',
      `归档预检已解压 ${rawHeaderSafety.expandedBytes} bytes，超过 ${rawHeaderSafety.maxExpandedBytes} bytes 上限。`,
    );
  if (!rawHeaderSafety.safe) throw fail('ARCHIVE_UNSAFE', '归档原始 header 不安全或无效。');
  const metadataHeaderSafety = await metadataHeaderTypes(filename, options.rawHeaderMaxBytes);
  if (!metadataHeaderSafety.safe && metadataHeaderSafety.reason === 'cap')
    throw fail(
      'E_ARCHIVE_PREFLIGHT_CAP',
      `归档预检已解压 ${metadataHeaderSafety.expandedBytes} bytes，超过 ${metadataHeaderSafety.maxExpandedBytes} bytes 上限。`,
    );
  if (!metadataHeaderSafety.safe) throw fail('ARCHIVE_UNSAFE', '归档原始 header 不安全或无效。');
  const state: ArchiveState = { diagnostics: [], githubRootName: undefined };
  const records: DeployableArchiveEntry[] = [];
  const fullDeployment = deploymentState();
  let entries = 0;
  let metaHeaders = 0;
  let consumedMeta = 0;
  let pendingGlobalHeaders = 0;
  let pendingPaxHeaders = 0;
  let pendingOtherMetaHeaders = 0;
  let sawGlobal = false;
  let failure: Error | undefined;
  let parserError: unknown;
  const record = (error: Error): void => {
    failure ??= error;
  };
  try {
    const parser = new Parser({ file: filename, strict: true });
    parser.on('meta', () => {
      const type = metadataHeaderSafety.types[metaHeaders];
      metaHeaders += 1;
      if (type === undefined) {
        record(fail('ARCHIVE_UNSAFE', '归档包含未允许的 header。'));
      } else if (type === 'g') {
        pendingGlobalHeaders += 1;
      } else if (type === 'x' || type === 'X') {
        pendingPaxHeaders += 1;
      } else {
        pendingOtherMetaHeaders += 1;
      }
    });
    parser.on('ignoredEntry', (entry: ReadEntry) => {
      record(fail('ARCHIVE_UNSAFE', '归档包含未允许的 header。'));
      entry.resume();
    });
    parser.on('entry', (entry: ReadEntry) => {
      entries += 1;
      if (!options.selectiveComposeSkills && entries > MAX_ENTRIES)
        record(fail('ARCHIVE_LIMIT', '归档超过条目数量限制。'));
      if (entry.globalExtended !== undefined && !sawGlobal) {
        sawGlobal = true;
        if (pendingGlobalHeaders === 0) {
          record(fail('ARCHIVE_UNSAFE', '归档包含未允许的 header。'));
        } else {
          consumedMeta += 1;
          pendingGlobalHeaders -= 1;
        }
      }
      const acceptedPax = acceptableGitHubPax(entry, expectedGitHub);
      if (acceptedPax) {
        consumedMeta += pendingPaxHeaders;
        pendingPaxHeaders = 0;
      }
      if (failure === undefined) {
        try {
          const inspected = inspectArchiveStructure(
            entry,
            state,
            fail,
            expectedGitHub,
            acceptedPax,
          );
          if (inspected !== undefined) {
            if (options.selectiveComposeSkills) records.push(inspected);
            else validateDeploymentEntry(inspected, fullDeployment, fail);
          }
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
  if (
    metaHeaders !== metadataHeaderSafety.types.length ||
    metaHeaders !== consumedMeta ||
    pendingGlobalHeaders !== 0 ||
    pendingPaxHeaders !== 0 ||
    pendingOtherMetaHeaders !== 0
  ) {
    throw fail('ARCHIVE_UNSAFE', '归档包含未允许的 header。');
  }
  if (entries === 0) throw fail('ARCHIVE_UNSAFE', '归档为空或无效。');
  if (!options.selectiveComposeSkills)
    return { diagnostics: state.diagnostics, githubRoot: state.githubRootName };

  const pack = records.some((entry) => isPackManifestEntry(entry, state.githubRootName));
  if (pack) {
    if (entries > MAX_ENTRIES) throw fail('ARCHIVE_LIMIT', '归档超过条目数量限制。');
    const fullDeployment = deploymentState();
    for (const entry of records) validateDeploymentEntry(entry, fullDeployment, fail);
    return { diagnostics: state.diagnostics, githubRoot: state.githubRootName };
  }

  const selected = records.filter((entry) =>
    selectedConventionalEntry(entry, state.githubRootName),
  );
  if (selected.length > MAX_ENTRIES) throw fail('ARCHIVE_LIMIT', '归档超过条目数量限制。');
  const selectedDeployment = deploymentState();
  for (const entry of selected) validateDeploymentEntry(entry, selectedDeployment, fail);
  const skipped = records.filter(
    (entry) =>
      entry.type !== 'Directory' && !selectedConventionalEntry(entry, state.githubRootName),
  );
  if (skipped.length > 0)
    state.diagnostics.push(
      selectiveSkippedDiagnostic(
        skipped.length,
        skipped.reduce((total, entry) => total + entry.size, 0),
      ),
    );
  return {
    diagnostics: state.diagnostics,
    githubRoot: state.githubRootName,
    selectedPaths: new Set(selected.map(({ path }) => path)),
  };
}

export async function inspectAndExtractArchive(
  archivePath: string,
  workspace: string,
  fail: ArchiveError,
  expectedGitHub?: GitHubArchiveExpectation,
  options?: ArchivePreflightOptions,
): Promise<{ directory: string; diagnostics: readonly Diagnostic[] }> {
  const { diagnostics, githubRoot, selectedPaths } = await preflight(
    archivePath,
    fail,
    expectedGitHub,
    options,
  );
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
      filter: (_path, entry) => {
        const archiveEntry = entry as ReadEntry;
        const path =
          archiveEntry.type === 'Directory' && archiveEntry.path.endsWith('/')
            ? archiveEntry.path.slice(0, -1)
            : archiveEntry.path;
        return deployableEntry(archiveEntry) && (selectedPaths?.has(path) ?? true);
      },
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
