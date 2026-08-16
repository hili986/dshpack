import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import {
  type Diagnostic,
  inspectSkill,
  type PackLock,
  type PackManifest,
  type PackTreeEntry,
  parseCanonicalYaml,
  parseLock,
  parsePack,
  scanSecrets,
  validatePackTree,
} from '@dshpack/core';

import {
  type CommandReport,
  diagnostic,
  exitCodeFor,
  strictDiagnostics,
} from '../commands/shared.js';

export interface ValidateOptions {
  strict?: boolean;
}

export interface ValidateMetadata {
  source: string;
  valid: boolean;
}

interface FileEntry {
  absolute: string;
  path: string;
  size: number;
}

interface TreeInspection {
  diagnostics: Diagnostic[];
  entries: PackTreeEntry[];
  files: FileEntry[];
}

function posixRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join('/');
}

function statKind(stat: Awaited<ReturnType<typeof lstat>>): PackTreeEntry['stat']['kind'] {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isBlockDevice()) return 'block-device';
  return 'character-device';
}

async function inspectTree(root: string): Promise<TreeInspection> {
  const diagnostics: Diagnostic[] = [];
  const entries: PackTreeEntry[] = [];
  const files: FileEntry[] = [];
  let rootStat: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStat = await lstat(root);
  } catch {
    return {
      diagnostics: [
        diagnostic(
          'E_SOURCE_DIRECTORY',
          'error',
          'SOURCE 必须是存在的本地目录。',
          '提供一个本地 pack 目录。',
          root,
        ),
      ],
      entries,
      files,
    };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return {
      diagnostics: [
        diagnostic(
          'E_SOURCE_DIRECTORY',
          'error',
          'SOURCE 必须是普通本地目录。',
          '不要使用符号链接或普通文件。',
          root,
        ),
      ],
      entries,
      files,
    };
  }

  const visit = async (directory: string): Promise<void> => {
    const names = await readdir(directory);
    for (const name of names) {
      const absolute = join(directory, name);
      const stat = await lstat(absolute);
      const path = posixRelative(root, absolute);
      const kind = statKind(stat);
      entries.push({ path, stat: { kind, size: stat.size } });
      if (kind === 'directory') await visit(absolute);
      if (kind === 'file') files.push({ absolute, path, size: stat.size });
    }
  };
  try {
    await visit(root);
  } catch {
    diagnostics.push(
      diagnostic(
        'E_SOURCE_READ',
        'error',
        '无法完整读取 pack 目录。',
        '检查目录权限或损坏的文件系统对象。',
        root,
      ),
    );
  }
  const tree = validatePackTree(entries);
  diagnostics.push(...tree.diagnostics);
  return { diagnostics, entries, files };
}

function sha512(content: Uint8Array): string {
  return `sha512-${createHash('sha512').update(content).digest('base64')}`;
}

function manifestSha256(content: Uint8Array): string {
  return `sha256-${createHash('sha256').update(content).digest('base64url')}`;
}

function isAllowedPath(path: string): boolean {
  if (['pack.yml', 'pack.lock.yml', 'export-report.json', 'patch/cordis.patch.yml'].includes(path))
    return true;
  if (/^skills\/[a-z0-9][a-z0-9-]*(?:\.md|\/SKILL\.md)$/u.test(path)) return true;
  if (/^presets\/[a-z0-9][a-z0-9-]*\/(?:agent\.cordis\.yml|preset\.yml)$/u.test(path)) return true;
  if (/^presets\/[a-z0-9][a-z0-9-]*\/skills\/[a-z0-9][a-z0-9-]*(?:\.md|\/SKILL\.md)$/u.test(path))
    return true;
  return path === 'settings/agent-presets.yml' || path.startsWith('agents-md/');
}

function contentDiagnostics(path: string, content: string): readonly Diagnostic[] {
  const namespace = path === 'settings/agent-presets.yml' ? 'agent-presets' : undefined;
  const diagnostics = scanSecrets({
    path,
    content,
    ...(namespace === undefined ? {} : { settingsNamespace: namespace }),
  });
  // pack.lock.yml necessarily contains base64 hashes. They are independently schema- and
  // digest-checked below, so they must not be mistaken for user-provided high-entropy secrets.
  return path === 'pack.lock.yml'
    ? diagnostics.filter(({ code }) => code !== 'E_SECRET_HIGH_ENTROPY')
    : diagnostics;
}

function layoutDiagnostics(paths: ReadonlySet<string>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const path of paths) {
    if (path === 'overrides' || path.startsWith('overrides/')) {
      diagnostics.push(
        diagnostic(
          'E_OVERRIDES_RESERVED',
          'error',
          'overrides/ 是 M0 保留目录，当前拒绝使用。',
          '移除 overrides/。',
          path,
        ),
      );
    } else if (!isAllowedPath(path) && !path.endsWith('/')) {
      diagnostics.push(
        diagnostic(
          'E_LAYOUT_UNKNOWN',
          'error',
          'pack 包含 v0 未声明的文件。',
          '移除该文件或使用 v0 允许的目录。',
          path,
        ),
      );
    }
  }
  for (const required of ['pack.yml', 'pack.lock.yml', 'patch/cordis.patch.yml']) {
    if (!paths.has(required))
      diagnostics.push(
        diagnostic(
          'E_LAYOUT_REQUIRED',
          'error',
          `缺少必需文件 ${required}。`,
          `创建 ${required}。`,
          required,
        ),
      );
  }
  for (const path of paths) {
    const parts = path.split('/');
    const preset = parts[0] === 'presets' ? parts[1] : undefined;
    if (preset !== undefined && ['standard', 'code', 'minimal', 'cordis'].includes(preset)) {
      diagnostics.push(
        diagnostic(
          'E_PRESET_RESERVED',
          'error',
          'preset id 与 dsh shipped preset 冲突。',
          '使用非保留的 kebab-case id。',
          path,
        ),
      );
    }
  }
  return diagnostics;
}

function lockDiagnostics(
  lock: PackLock,
  manifest: PackManifest,
  packBytes: Uint8Array,
  contents: ReadonlyMap<string, Uint8Array>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (lock.manifestSha256 !== manifestSha256(packBytes)) {
    diagnostics.push(
      diagnostic(
        'E_LOCK_MANIFEST_DIGEST',
        'error',
        'pack.lock.yml 的 manifestSha256 与 pack.yml 不一致。',
        '重新生成 lock。',
        'pack.lock.yml',
      ),
    );
  }
  const expectedPlugins = manifest.plugins.map(({ name }) => name);
  if (JSON.stringify(lock.plugins.map(({ name }) => name)) !== JSON.stringify(expectedPlugins)) {
    diagnostics.push(
      diagnostic(
        'E_LOCK_PLUGIN_MISMATCH',
        'error',
        'pack.lock.yml plugins 与 manifest plugins 不一致。',
        '按 manifest 顺序重新生成 lock。',
        'pack.lock.yml',
      ),
    );
  }
  const lockedFiles = new Map(lock.files.map((file) => [file.path, file.sha512]));
  for (const [path, bytes] of contents) {
    if (path === 'pack.yml' || path === 'pack.lock.yml') continue;
    if (lockedFiles.get(path) !== sha512(bytes)) {
      diagnostics.push(
        diagnostic(
          'E_LOCK_PAYLOAD_DIGEST',
          'error',
          'payload 文件缺少或不匹配 sha512。',
          '重新生成 pack.lock.yml。',
          path,
        ),
      );
    }
  }
  for (const file of lock.files) {
    if (!contents.has(file.path))
      diagnostics.push(
        diagnostic(
          'E_LOCK_PAYLOAD_MISSING',
          'error',
          'lock 引用了不存在的 payload 文件。',
          '删除失效 lock 条目或恢复文件。',
          file.path,
        ),
      );
  }
  return diagnostics;
}

function manifestDiagnostics(manifest: PackManifest): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const plugin of manifest.plugins) {
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(plugin.name)) {
      diagnostics.push(
        diagnostic(
          'E_PLUGIN_NAME',
          'error',
          'plugins.name 不是合法 npm package 名。',
          '使用 npm 合法包名。',
          plugin.name,
        ),
      );
    }
  }
  for (const mcp of manifest.mcp) {
    try {
      const url = new URL(mcp.url);
      if (
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) => /token|secret|key|auth|password/iu.test(key))
      ) {
        diagnostics.push(
          diagnostic(
            'E_MCP_CREDENTIAL',
            'error',
            'MCP URL 不能携带凭据或敏感 query。',
            '使用无凭据 streamable-http URL。',
            mcp.serverName,
          ),
        );
      }
    } catch {
      diagnostics.push(
        diagnostic('E_MCP_URL', 'error', 'MCP URL 无法解析。', '使用 HTTPS URL。', mcp.serverName),
      );
    }
  }
  return diagnostics;
}

/** Validate a local v0 pack without spawning dsh or mutating any path. */
export async function validateLocalPack(
  source: string,
  options: ValidateOptions = {},
): Promise<CommandReport<ValidateMetadata>> {
  const diagnostics: Diagnostic[] = [];
  if (/^(?:github:|https?:\/\/)/u.test(source)) {
    diagnostics.push(
      diagnostic(
        'E_W12_REMOTE_SOURCE',
        'error',
        '远程 SOURCE 属于 W12，validate 目前只接受本地目录。',
        '先下载为本地目录后再 validate。',
        source,
      ),
    );
    return { diagnostics, exitCode: 70, metadata: { source, valid: false } };
  }
  const inspected = await inspectTree(source);
  diagnostics.push(...inspected.diagnostics);
  const paths = new Set(inspected.entries.map(({ path }) => path));
  const filePaths = new Set(inspected.files.map(({ path }) => path));
  diagnostics.push(...layoutDiagnostics(filePaths));
  if (paths.has('overrides') && !filePaths.has('overrides')) {
    diagnostics.push(
      diagnostic(
        'E_OVERRIDES_RESERVED',
        'error',
        'overrides/ 是 M0 保留目录，当前拒绝使用。',
        '移除 overrides/。',
        'overrides',
      ),
    );
  }

  const contents = new Map<string, Uint8Array>();
  for (const file of inspected.files) {
    try {
      const bytes = await readFile(file.absolute);
      contents.set(file.path, bytes);
      const text = Buffer.from(bytes).toString('utf8');
      diagnostics.push(...contentDiagnostics(file.path, text));
      if (basename(file.path) === 'SKILL.md' || /^skills\/[^/]+\.md$/u.test(file.path)) {
        diagnostics.push(...inspectSkill(text, file.path));
      }
    } catch {
      diagnostics.push(
        diagnostic('E_SOURCE_READ', 'error', '无法读取 pack 文件。', '检查文件权限。', file.path),
      );
    }
  }

  const packBytes = contents.get('pack.yml');
  const lockBytes = contents.get('pack.lock.yml');
  if (packBytes !== undefined) {
    const parsed = parsePack(Buffer.from(packBytes).toString('utf8'));
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value !== undefined) diagnostics.push(...manifestDiagnostics(parsed.value));
    if (lockBytes !== undefined && parsed.value !== undefined) {
      const lock = parseLock(Buffer.from(lockBytes).toString('utf8'));
      diagnostics.push(...lock.diagnostics);
      if (lock.value !== undefined)
        diagnostics.push(...lockDiagnostics(lock.value, parsed.value, packBytes, contents));
    }
  }
  const patch = contents.get('patch/cordis.patch.yml');
  if (patch !== undefined) {
    const parsed = parseCanonicalYaml(Buffer.from(patch).toString('utf8'), { allowJsTag: true });
    diagnostics.push(...parsed.diagnostics);
    if (parsed.ok && !Array.isArray(parsed.value?.value)) {
      diagnostics.push(
        diagnostic(
          'E_PATCH_TOP_LEVEL',
          'error',
          'patch/cordis.patch.yml 顶层必须是 YAML array。',
          '合法空 patch 写成 []。',
          'patch/cordis.patch.yml',
        ),
      );
    }
  }
  const finalDiagnostics = strictDiagnostics(diagnostics, options.strict === true);
  return {
    diagnostics: finalDiagnostics,
    exitCode: exitCodeFor(finalDiagnostics),
    metadata: { source, valid: !finalDiagnostics.some((item) => item.severity === 'error') },
  };
}
