import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'undici';
import { EXIT_CODES } from '../exit-codes.js';
import { inspectAndExtractArchive } from './source-archive.js';

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const GITHUB_HINT = '请先运行 git clone，再从本地普通目录安装。';

export interface DownloadResponse {
  statusCode: number;
  location?: string;
  body?: AsyncIterable<Uint8Array>;
  discard?: () => Promise<void>;
}

export interface SourceDependencies {
  download?: (url: URL) => Promise<DownloadResponse>;
  makeTempDirectory?: () => Promise<string>;
  removeTempDirectory?: (path: string) => Promise<void>;
  hostnamePolicy?: (hostname: string) => boolean | Promise<boolean>;
}

export type SourceProvenance =
  | { kind: 'directory'; path: string }
  | { kind: 'archive'; path: string }
  | { kind: 'https'; url: string; integrity: string }
  | { kind: 'github'; owner: string; repo: string; commit: string; url: string };

export interface MaterializedSource {
  directory: string;
  provenance: SourceProvenance;
  cleanup(): Promise<void>;
}

export interface SourceAdapter {
  materialize(reference: string, dependencies?: SourceDependencies): Promise<MaterializedSource>;
}

export class SourceError extends Error {
  readonly code: string;
  readonly exitCode: 20 | 31;
  readonly hint?: string;

  constructor(code: string, exitCode: 20 | 31, message: string, hint?: string) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.exitCode = exitCode;
    if (hint !== undefined) this.hint = hint;
  }
}

function sourceFailure(code: string, message: string, hint?: string): SourceError {
  return new SourceError(code, EXIT_CODES.SOURCE_NETWORK_INTEGRITY, message, hint);
}

function archiveFailure(code: string, message: string): SourceError {
  return new SourceError(code, EXIT_CODES.SECURITY, message);
}

async function defaultDownload(url: URL): Promise<DownloadResponse> {
  const response = await request(url, {
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
  });
  const location = response.headers.location;
  return {
    statusCode: response.statusCode,
    ...(typeof location === 'string' ? { location } : {}),
    body: response.body,
    discard: () => response.body.dump(),
  };
}

async function defaultMakeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dshpack-source-'));
  await chmod(directory, 0o700);
  return directory;
}

const defaultRemoveTempDirectory = (path: string): Promise<void> =>
  rm(path, { recursive: true, force: true });

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isRejectedLiteralHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const kind = isIP(host);
  if (kind === 4) {
    const parts = host.split('.').map(Number);
    const first = parts[0] ?? 0;
    const second = parts[1] ?? 0;
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (kind === 6) {
    if (host === '::1') return true;
    if (host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/u.test(host)) return true;
    return host.startsWith('::ffff:');
  }
  return false;
}

async function assertAllowedUrl(
  url: URL,
  hostnamePolicy: SourceDependencies['hostnamePolicy'],
): Promise<void> {
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw sourceFailure('SOURCE_INVALID', '远程 source URL 不符合安全策略。');
  }
  if (isRejectedLiteralHost(url.hostname)) {
    throw sourceFailure('SOURCE_HOST_REJECTED', '远程 source 主机被安全策略拒绝。');
  }
  if (hostnamePolicy !== undefined && !(await hostnamePolicy(stripIpv6Brackets(url.hostname)))) {
    throw sourceFailure('SOURCE_HOST_REJECTED', '远程 source 主机被安全策略拒绝。');
  }
}

function parseHttpsSource(reference: string): { requestUrl: URL; integrity: string } {
  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    throw sourceFailure('SOURCE_INVALID', '远程 source URL 无效。');
  }
  const integrity = url.hash.slice(1);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity)) {
    throw sourceFailure('SOURCE_INVALID', 'HTTPS tarball 必须提供有效 sha512 完整性片段。');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== ''
  ) {
    throw sourceFailure('SOURCE_INVALID', '远程 source URL 不符合安全策略。');
  }
  url.hash = '';
  return { requestUrl: url, integrity };
}

function githubSource(reference: string): {
  owner: string;
  repo: string;
  commit: string;
  requestUrl: URL;
} {
  const match =
    /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)#([0-9a-f]{40})$/u.exec(
      reference,
    );
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    throw sourceFailure(
      'SOURCE_INVALID',
      'GitHub source 必须固定到 40 位小写 commit SHA。',
      GITHUB_HINT,
    );
  }
  const [, owner, repo, commit] = match;
  return {
    owner,
    repo,
    commit,
    requestUrl: new URL(`https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`),
  };
}

async function discard(response: DownloadResponse): Promise<void> {
  await response.discard?.().catch(() => undefined);
}

async function downloadToPrivateFile(
  initialUrl: URL,
  filename: string,
  dependencies: SourceDependencies,
  expectedIntegrity?: string,
  hint?: string,
): Promise<void> {
  const handle = await open(filename, 'wx', 0o600);
  const hash = createHash('sha512');
  let total = 0;
  let current = initialUrl;
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await assertAllowedUrl(current, dependencies.hostnamePolicy);
      let response: DownloadResponse;
      try {
        response = await (dependencies.download ?? defaultDownload)(current);
      } catch {
        throw sourceFailure('SOURCE_NETWORK', '远程 source 下载失败。', hint);
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        await discard(response);
        if (response.location === undefined || redirects === MAX_REDIRECTS) {
          throw sourceFailure('SOURCE_NETWORK', '远程 source 重定向无效。', hint);
        }
        try {
          current = new URL(response.location, current);
        } catch {
          throw sourceFailure('SOURCE_NETWORK', '远程 source 重定向无效。', hint);
        }
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300 || response.body === undefined) {
        await discard(response);
        throw sourceFailure('SOURCE_NETWORK', '远程 source 下载失败。', hint);
      }
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          throw sourceFailure('SOURCE_TOO_LARGE', '远程 source 超过 50 MiB 限制。', hint);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      if (
        expectedIntegrity !== undefined &&
        `sha512-${hash.digest('base64')}` !== expectedIntegrity
      ) {
        throw sourceFailure('SOURCE_INTEGRITY', '远程 source 完整性校验失败。', hint);
      }
      return;
    }
    throw sourceFailure('SOURCE_NETWORK', '远程 source 重定向过多。', hint);
  } finally {
    await handle.close();
  }
}

function cleanupOnce(
  path: string,
  removeDirectory: (path: string) => Promise<void>,
): () => Promise<void> {
  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    await removeDirectory(path).catch(() => undefined);
  };
}

async function materializeArchive(
  source: { localPath?: string; url?: URL; integrity?: string; hint?: string },
  provenance: SourceProvenance,
  dependencies: SourceDependencies,
): Promise<MaterializedSource> {
  const makeTempDirectory = dependencies.makeTempDirectory ?? defaultMakeTempDirectory;
  const removeDirectory = dependencies.removeTempDirectory ?? defaultRemoveTempDirectory;
  let workspace: string | undefined;
  try {
    workspace = await makeTempDirectory();
    await chmod(workspace, 0o700);
    const archivePath = join(workspace, 'source.dshpack.tgz');
    if (source.localPath !== undefined) {
      if ((await stat(source.localPath)).size > MAX_DOWNLOAD_BYTES) {
        throw sourceFailure('SOURCE_TOO_LARGE', '本地 source 归档超过 50 MiB 限制。');
      }
      await open(archivePath, 'wx', 0o600).then((handle) => handle.close());
      await copyFile(source.localPath, archivePath);
      await chmod(archivePath, 0o600);
    } else if (source.url !== undefined) {
      await downloadToPrivateFile(
        source.url,
        archivePath,
        dependencies,
        source.integrity,
        source.hint,
      );
    }
    const directory = await inspectAndExtractArchive(archivePath, workspace, archiveFailure);
    return { directory, provenance, cleanup: cleanupOnce(workspace, removeDirectory) };
  } catch (error) {
    if (workspace !== undefined) await removeDirectory(workspace).catch(() => undefined);
    if (error instanceof SourceError) throw error;
    throw sourceFailure('SOURCE_IO', 'source 无法读取或暂存。');
  }
}

export async function materializeSource(
  reference: string,
  dependencies: SourceDependencies = {},
): Promise<MaterializedSource> {
  if (reference.startsWith('github:')) {
    const parsed = githubSource(reference);
    const provenance: SourceProvenance = {
      kind: 'github',
      owner: parsed.owner,
      repo: parsed.repo,
      commit: parsed.commit,
      url: parsed.requestUrl.href,
    };
    return materializeArchive(
      { url: parsed.requestUrl, hint: GITHUB_HINT },
      provenance,
      dependencies,
    );
  }
  if (/^https?:\/\//iu.test(reference)) {
    const parsed = parseHttpsSource(reference);
    return materializeArchive(
      { url: parsed.requestUrl, integrity: parsed.integrity },
      { kind: 'https', url: parsed.requestUrl.href, integrity: parsed.integrity },
      dependencies,
    );
  }
  const path = resolve(reference);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw sourceFailure('SOURCE_INVALID', '本地 source 不存在或无法读取。');
  }
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    return {
      directory: path,
      provenance: { kind: 'directory', path },
      cleanup: async () => undefined,
    };
  }
  if (metadata.isFile() && path.endsWith('.dshpack.tgz')) {
    return materializeArchive({ localPath: path }, { kind: 'archive', path }, dependencies);
  }
  throw sourceFailure('SOURCE_INVALID', '本地 source 必须是普通目录或 .dshpack.tgz 文件。');
}
