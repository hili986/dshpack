import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

import { type Diagnostic, type PluginSource, parseCanonicalYaml, scanSecrets } from '@dshpack/core';

import { diagnostic } from '../commands/shared.js';

export interface Material {
  bytes: Uint8Array;
  path: string;
}

export function sha512(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

export function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

export function sourceFromSpecifier(
  name: string,
  specifier: string,
): { source?: PluginSource; diagnostics: Diagnostic[] } {
  if (/^github:/u.test(specifier)) {
    const match = /^github:([^/\s]+)\/([^#\s]+)#([a-f0-9]{40})$/u.exec(specifier);
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      return {
        source: { kind: 'github', owner: match[1], repo: match[2], ref: match[3] },
        diagnostics: [],
      };
    }
    return {
      diagnostics: [
        diagnostic(
          'E_EXPORT_GIT_PIN',
          'error',
          'Git bundle 必须有 40 位小写 SHA pin。',
          '重新安装为 github:owner/repo#<sha>。',
          name,
        ),
      ],
    };
  }
  if (/^https:\/\//u.test(specifier))
    return { source: { kind: 'tarball', url: specifier }, diagnostics: [] };
  return { source: { kind: 'npm', range: specifier }, diagnostics: [] };
}

export async function materialFromFile(
  absolute: string,
  path: string,
): Promise<{ material?: Material; diagnostics: Diagnostic[] }> {
  try {
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        diagnostics: [
          diagnostic(
            'E_EXPORT_PATH',
            'error',
            '导出资产必须是普通文件，拒绝 symlink 与特殊文件。',
            '移除该文件或改为普通文件。',
            path,
          ),
        ],
      };
    }
    const bytes = await readFile(absolute);
    return { material: { path, bytes }, diagnostics: [] };
  } catch {
    return {
      diagnostics: [
        diagnostic('E_EXPORT_READ', 'error', '无法读取导出资产。', '检查文件权限。', path),
      ],
    };
  }
}

export async function collectDirectory(
  root: string,
  prefix: string,
): Promise<{ materials: Material[]; diagnostics: Diagnostic[] }> {
  const materials: Material[] = [];
  const diagnostics: Diagnostic[] = [];
  const visit = async (directory: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(directory, { encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      diagnostics.push(
        diagnostic('E_EXPORT_READ', 'error', '无法读取导出目录。', '检查目录权限。', directory),
      );
      return;
    }
    for (const name of names) {
      const absolute = join(directory, name);
      const path = `${prefix}/${posix(relative(root, absolute))}`;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        diagnostics.push(
          diagnostic(
            'E_EXPORT_PATH',
            'error',
            '导出资产包含 symlink 或特殊文件。',
            '仅使用普通文件与目录。',
            path,
          ),
        );
        continue;
      }
      if (stat.isDirectory()) await visit(absolute);
      if (stat.isFile()) {
        const material = await materialFromFile(absolute, path);
        diagnostics.push(...material.diagnostics);
        if (material.material !== undefined) materials.push(material.material);
      }
    }
  };
  await visit(root);
  return { materials, diagnostics };
}

/** Scan profile-visible filenames before collection; node_modules and profile pnpm lock are deliberately not payload. */
export async function scanProfileNames(profileRoot: string): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const visit = async (directory: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(directory, { encoding: 'utf8' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      diagnostics.push(
        diagnostic(
          'E_EXPORT_READ',
          'error',
          '无法扫描 profile。',
          '检查 profile 权限。',
          directory,
        ),
      );
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === 'pnpm-lock.yaml') continue;
      const absolute = join(directory, name);
      const relativeName = posix(relative(profileRoot, absolute));
      diagnostics.push(...scanSecrets({ path: relativeName }));
      const stat = await lstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(absolute);
    }
  };
  await visit(profileRoot);
  return diagnostics;
}

export function mcpFromPatch(source: string): {
  mcp: Array<{ serverName: string; transport: 'streamable-http'; url: string }>;
  diagnostics: Diagnostic[];
} {
  const parsed = parseCanonicalYaml(source, { allowJsTag: true });
  if (!parsed.ok || !Array.isArray(parsed.value?.value)) return { mcp: [], diagnostics: [] };
  const mcp: Array<{ serverName: string; transport: 'streamable-http'; url: string }> = [];
  const diagnostics: Diagnostic[] = [];
  for (const patch of parsed.value.value) {
    if (
      typeof patch !== 'object' ||
      patch === null ||
      !Array.isArray((patch as { insert?: unknown }).insert)
    )
      continue;
    for (const entry of (patch as { insert: unknown[] }).insert) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as { name?: unknown; config?: unknown };
      if (
        record.name !== '@deepseek-ai/dsh-mcp-client' ||
        typeof record.config !== 'object' ||
        record.config === null
      )
        continue;
      const config = record.config as Record<string, unknown>;
      if (
        typeof config.serverName !== 'string' ||
        config.transport !== 'streamable-http' ||
        typeof config.url !== 'string'
      ) {
        diagnostics.push(
          diagnostic(
            'E_EXPORT_MCP',
            'error',
            'MCP bundle 配置不符合 v0 streamable-http 契约。',
            '移除该 MCP 或使用无凭据 streamable-http 配置。',
          ),
        );
        continue;
      }
      diagnostics.push(...scanSecrets({ path: `mcp/${config.serverName}`, content: config.url }));
      mcp.push({ serverName: config.serverName, transport: 'streamable-http', url: config.url });
    }
  }
  return { mcp, diagnostics };
}

export async function prepareOutput(
  output: string,
  yes: boolean,
): Promise<{ temporary?: string; diagnostics: Diagnostic[] }> {
  try {
    const stat = await lstat(output);
    if (!stat.isDirectory())
      return {
        diagnostics: [
          diagnostic(
            'E_EXPORT_OUTPUT',
            'error',
            '输出路径已存在且不是目录。',
            '选择不存在的输出目录。',
            output,
          ),
        ],
      };
    const entries = await readdir(output);
    if (entries.length !== 0 || !yes) {
      return {
        diagnostics: [
          diagnostic(
            'E_EXPORT_OUTPUT_CONFIRM',
            'error',
            '输出目录已存在；仅已确认的空目录可使用。',
            `非交互执行：dshpack export --output "${output}" --yes`,
            output,
          ),
        ],
      };
    }
    await rmdir(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return {
        diagnostics: [
          diagnostic('E_EXPORT_OUTPUT', 'error', '无法检查输出路径。', '检查父目录权限。', output),
        ],
      };
  }
  try {
    return {
      temporary: await mkdtemp(
        join(dirname(output), `.dshpack-export-${randomBytes(4).toString('hex')}-`),
      ),
      diagnostics: [],
    };
  } catch {
    return {
      diagnostics: [
        diagnostic(
          'E_EXPORT_OUTPUT',
          'error',
          '无法创建导出临时目录。',
          '检查输出父目录权限。',
          output,
        ),
      ],
    };
  }
}

export async function writeMaterials(root: string, materials: readonly Material[]): Promise<void> {
  for (const material of materials) {
    const absolute = join(root, ...material.path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, material.bytes, { flag: 'wx' });
  }
}

export async function abandonTemporary(path: string | undefined): Promise<void> {
  if (path !== undefined) await rm(path, { recursive: true, force: true });
}

export async function publishTemporary(temporary: string, output: string): Promise<void> {
  await rename(temporary, output);
}

export function fileName(path: string): string {
  return basename(path);
}
