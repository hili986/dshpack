import { parseCanonicalYaml } from '@dshpack/core';

import { InstallProfileError, isRecord } from './profile-common.js';

const mcpBundle = '@deepseek-ai/dsh-mcp-client';

export interface ProfileMcpDeclaration {
  serverName: string;
  transport: 'streamable-http';
  url: string;
}

interface ExistingMcp {
  id?: unknown;
  config?: unknown;
}

function failure(code: string, message: string): never {
  throw new InstallProfileError(code, message, 'patch/cordis.patch.yml');
}

function collectInsertedEntries(rows: readonly unknown[]): {
  ids: Set<string>;
  mcp: ExistingMcp[];
} {
  const ids = new Set<string>();
  const mcp: ExistingMcp[] = [];
  const pending: unknown[] = [];
  for (const row of rows) {
    if (!isRecord(row)) failure('E_MCP_PATCH_CONTRACT', 'profile patch 条目必须是 mapping。');
    if (row.insert !== undefined && !Array.isArray(row.insert))
      failure('E_MCP_PATCH_CONTRACT', 'profile patch insert 必须是数组。');
    if (Array.isArray(row.insert)) pending.push(...row.insert);
  }
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!isRecord(entry))
      failure('E_MCP_PATCH_CONTRACT', 'profile patch insert 条目必须是 mapping。');
    if (typeof entry.id === 'string' && entry.id !== '') {
      if (ids.has(entry.id)) failure('E_MCP_PATCH_ID', `profile patch 的 id 重复：${entry.id}`);
      ids.add(entry.id);
    }
    if (entry.name === mcpBundle) mcp.push({ id: entry.id, config: entry.config });
    if (entry.group && Array.isArray(entry.config)) pending.push(...entry.config);
  }
  return { ids, mcp };
}

function existingServer(entry: ExistingMcp): ProfileMcpDeclaration & { id: string } {
  if (typeof entry.id !== 'string' || entry.id === '' || !isRecord(entry.config))
    return failure('E_MCP_PATCH_CONTRACT', '已有 MCP patch 缺少安全的 id/config。');
  const { serverName, transport, url } = entry.config;
  if (typeof serverName !== 'string' || transport !== 'streamable-http' || typeof url !== 'string')
    return failure('E_MCP_PATCH_CONTRACT', '已有 MCP patch 不符合 streamable-http 契约。');
  return { id: entry.id, serverName, transport, url };
}

/** Bind reviewed manifest MCP declarations into the installed profile patch. */
export function renderProfilePatch(
  source: string,
  declarations: readonly ProfileMcpDeclaration[],
): string {
  const parsed = parseCanonicalYaml(source, { allowJsTag: true });
  if (!parsed.ok) {
    const issue = parsed.diagnostics[0] as { code: string; message: string };
    return failure(issue.code, issue.message);
  }
  const canonical = parsed.value as NonNullable<typeof parsed.value>;
  if (!Array.isArray(canonical.value))
    return failure('E_MCP_PATCH_TOP_LEVEL', 'profile patch 顶层必须是数组。');

  const declared = new Map(declarations.map((item) => [item.serverName, item]));
  const seen = new Set<string>();
  const existing = collectInsertedEntries(canonical.value);
  for (const raw of existing.mcp) {
    const current = existingServer(raw);
    const expected = declared.get(current.serverName);
    if (expected === undefined)
      return failure(
        'E_MCP_PATCH_UNDECLARED',
        `profile patch 含未在 manifest 声明的 MCP：${current.serverName}`,
      );
    if (seen.has(current.serverName))
      return failure('E_MCP_PATCH_DUPLICATE', `MCP serverName 重复：${current.serverName}`);
    if (current.transport !== expected.transport || current.url !== expected.url)
      return failure('E_MCP_PATCH_CONFLICT', `MCP ${current.serverName} 与 manifest 不一致。`);
    seen.add(current.serverName);
  }

  const missing = declarations.filter(({ serverName }) => !seen.has(serverName));
  if (missing.length === 0) return source;
  for (const item of missing) {
    const id = `mcp-${item.serverName}`;
    if (existing.ids.has(id))
      return failure('E_MCP_PATCH_ID', `MCP ${item.serverName} 的生成 id 已被占用。`);
    existing.ids.add(id);
    canonical.document.add({
      insert: [
        {
          id,
          name: mcpBundle,
          config: {
            serverName: item.serverName,
            transport: item.transport,
            url: item.url,
          },
        },
      ],
    });
  }
  return canonical.document.toString({ lineWidth: 0 });
}
