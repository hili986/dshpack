import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PackLockedPlugin, PluginDeclaration } from '@dshpack/core';

import { SourceError } from '../adapters/source.js';
import {
  defaultDownload,
  type NetworkDependencies,
  resolvePublicTarget,
} from '../adapters/source-network.js';
import { stageVerifiedPluginTarball } from './profile-tarball.js';
import type { StagedPluginDownload } from './runtime-types.js';

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function failure(code: string, message: string): SourceError {
  return new SourceError(code, 20, message);
}

async function removePrivate(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    throw failure('E_PLUGIN_CLEANUP', `插件私有暂存清理失败：${path}`);
  }
}

function safeUrl(value: string | URL): URL {
  const raw = value instanceof URL ? value.href : value;
  const hasRawControl = [...raw].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x20 || (code >= 0x7f && code <= 0x9f);
  });
  if (hasRawControl || /%(?:0[0-9a-f]|1[0-9a-f]|20|7f|8[0-9a-f]|9[0-9a-f])/iu.test(raw))
    throw failure('E_PLUGIN_URL', '插件 tarball URL 含控制字符或不安全空白。');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw failure('E_PLUGIN_URL', '插件 tarball URL 无法解析。');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw failure('E_PLUGIN_URL', '插件 tarball 必须是无 userinfo 的 HTTPS URL。');
  if ([...url.searchParams.keys()].some((key) => /token|secret|key|auth|password/iu.test(key)))
    throw failure('E_PLUGIN_URL_SECRET', '插件 tarball URL 含疑似凭据 query。');
  return url;
}

function lockedFacts(
  plugin: PluginDeclaration,
  locked: PackLockedPlugin,
): { url: URL; sri: string } {
  if (
    plugin.source.kind !== 'tarball' ||
    !('url' in locked.resolved) ||
    locked.resolved.url !== plugin.source.url ||
    locked.integrity.kind !== 'sha512'
  )
    throw failure('E_PLUGIN_LOCK', 'tarball 插件缺少精确 URL 与 sha512 lock。');
  return { url: safeUrl(plugin.source.url), sri: locked.integrity.value };
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw failure('E_PLUGIN_DOWNLOAD', '插件下载无法继续写入。');
    offset += result.bytesWritten;
  }
}

async function downloadVerified(
  initial: URL,
  destination: string,
  expectedSri: string,
  dependencies: NetworkDependencies,
): Promise<void> {
  let current = initial;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const address = await resolvePublicTarget(current, dependencies, failure);
    const response = await (dependencies.download ?? defaultDownload)(current, address);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      await response.cancel?.();
      if (response.location === undefined || redirects === MAX_REDIRECTS)
        throw failure('E_PLUGIN_REDIRECT', '插件 tarball redirect 缺少安全目标或超过上限。');
      current = safeUrl(new URL(response.location, current));
      continue;
    }
    if (response.statusCode !== 200 || response.body === undefined) {
      await response.cancel?.();
      throw failure('E_PLUGIN_HTTP', `插件 tarball HTTP 状态为 ${response.statusCode}。`);
    }
    const hash = createHash('sha512');
    const handle = await open(destination, 'wx', 0o600);
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > MAX_DOWNLOAD_BYTES)
          throw failure('E_PLUGIN_TOO_LARGE', '插件 tarball 超过 50 MiB 上限。');
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const actual = `sha512-${hash.digest('base64')}`;
    if (actual !== expectedSri)
      throw failure('E_PLUGIN_INTEGRITY', '插件 tarball sha512 与 lock 不一致。');
    return;
  }
  throw failure('E_PLUGIN_REDIRECT', '插件 tarball redirect 超过上限。');
}

/** Download into transaction-private storage, then expose only a second verified staged copy. */
export async function stagePluginTarballDownload(
  plugin: PluginDeclaration,
  locked: PackLockedPlugin,
  privateParent: string,
  dependencies: NetworkDependencies = {},
): Promise<StagedPluginDownload> {
  const facts = lockedFacts(plugin, locked);
  const workspace = await mkdtemp(join(privateParent, 'plugin-download-'));
  await chmod(workspace, 0o700);
  try {
    const download = join(workspace, 'download.tgz');
    await downloadVerified(facts.url, download, facts.sri, dependencies);
    const staged = await stageVerifiedPluginTarball(download, privateParent, facts.sri);
    const stagedDirectory = dirname(staged.path);
    let cleaned = false;
    return {
      staged,
      async cleanup() {
        if (cleaned) return;
        await removePrivate(stagedDirectory);
        await removePrivate(workspace);
        cleaned = true;
      },
    };
  } catch (error) {
    await removePrivate(workspace);
    throw error;
  }
}
