import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type Diagnostic, type Result, scanSecrets } from '@dshpack/core';
import { Document, isNode, parseDocument, visit } from 'yaml';

import { writeFileAtomic } from '../adapters/fs.js';
import {
  settingsIoFailure,
  withSettingsFileLock,
  type YamlSettingsAdapterOptions,
} from '../adapters/settings-lock.js';

function success<T>(value: T): Result<T> {
  return { ok: true, value, diagnostics: [] };
}

function failure<T>(code: string, message: string, hint: string, path: string): Result<T> {
  const item: Diagnostic = { code, severity: 'error', message, hint, path, evidence: 'local' };
  return { ok: false, diagnostics: [item] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAliasOrAnchor(value: unknown): boolean {
  if (!isNode(value)) return false;
  let found = false;
  visit(value, {
    Alias: () => {
      found = true;
      return visit.BREAK;
    },
    Node: (_key, node) => {
      if (node.anchor === undefined) return;
      found = true;
      return visit.BREAK;
    },
  });
  return found;
}

async function ordinarySource(path: string): Promise<Result<string>> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? success('')
      : settingsIoFailure(path);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink())
    return failure(
      'E_PATH_SETTINGS',
      'settings.yaml 不是普通文件，已拒绝读取或覆盖。',
      '移除 symlink、junction 或同名目录后重试。',
      path,
    );
  try {
    return success(await readFile(path, 'utf8'));
  } catch {
    return settingsIoFailure(path);
  }
}

interface ParsedAgentPresets {
  document: Document;
  section: Record<string, unknown>;
}

function parseAgentPresets(current: string, path: string): Result<ParsedAgentPresets> {
  const document = parseDocument(current.trim() === '' ? '{}\n' : current, { prettyErrors: true });
  if (document.errors.length > 0)
    return failure(
      'E_SETTINGS_INVALID_YAML',
      'settings.yaml 不是有效 YAML，已拒绝覆盖。',
      '先修复 YAML 语法再重试。',
      path,
    );
  if (hasAliasOrAnchor(document.getIn(['agent-presets'], true)))
    return failure(
      'E_SETTINGS_ALIAS',
      'agent-presets 含 YAML alias 或 anchor，已拒绝覆盖。',
      '先展开该 namespace 的 alias/anchor，避免修改联动到其他 namespace。',
      path,
    );
  const root: unknown = document.toJS() ?? {};
  if (!isRecord(root))
    return failure(
      'E_SETTINGS_ROOT',
      'settings.yaml 顶层必须是 namespace map，已拒绝覆盖。',
      '将顶层改为 YAML map 后重试。',
      path,
    );
  const rawSection = root['agent-presets'];
  if (rawSection !== undefined && !isRecord(rawSection))
    return failure(
      'E_SWITCH_SETTINGS',
      'settings.yaml 的 agent-presets namespace 必须是 mapping。',
      '修复 settings.yaml 后重试。',
      path,
    );
  const section = rawSection ?? {};
  const currentCandidate = new Document({ 'agent-presets': section }).toString();
  const currentSecrets = scanSecrets({
    path: `${path}#agent-presets`,
    content: currentCandidate,
    settingsNamespace: 'agent-presets',
  });
  if (currentSecrets.length > 0) return { ok: false, diagnostics: currentSecrets };
  return success({ document, section });
}

export async function inspectCurrentAgentPresets(
  path: string,
): Promise<Result<{ selected: unknown }>> {
  const current = await ordinarySource(path);
  if (!current.ok || current.value === undefined)
    return { ok: false, diagnostics: current.diagnostics };
  const parsed = parseAgentPresets(current.value, path);
  if (!parsed.ok || parsed.value === undefined)
    return { ok: false, diagnostics: parsed.diagnostics };
  return success({ selected: parsed.value.section.selected });
}

async function updateUnderLock(path: string, preset: string): Promise<Result<void>> {
  const current = await ordinarySource(path);
  if (!current.ok || current.value === undefined)
    return { ok: false, diagnostics: current.diagnostics };
  const parsed = parseAgentPresets(current.value, path);
  if (!parsed.ok || parsed.value === undefined)
    return { ok: false, diagnostics: parsed.diagnostics };
  const { document, section } = parsed.value;
  document.setIn(['agent-presets', 'selected'], preset);
  const candidate = new Document({
    'agent-presets': Object.assign(Object.create(null) as Record<string, unknown>, section, {
      selected: preset,
    }),
  }).toString();
  const secretDiagnostics = scanSecrets({
    path: `${path}#agent-presets`,
    content: candidate,
    settingsNamespace: 'agent-presets',
  });
  if (secretDiagnostics.length > 0) return { ok: false, diagnostics: secretDiagnostics };
  await writeFileAtomic(path, document.toString(), { mode: 0o600, dirMode: 0o700 });
  return success(undefined);
}

/** Lock-scoped leaf RMW: a concurrent writer can never be erased by a stale pre-confirm snapshot. */
export async function updateSelectedPreset(
  path: string,
  preset: string,
  options: YamlSettingsAdapterOptions = {},
): Promise<Result<void>> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    return settingsIoFailure(path);
  }
  const locked = await withSettingsFileLock(path, () => updateUnderLock(path, preset), options);
  if (!locked.ok) return { ok: false, diagnostics: locked.diagnostics };
  return locked.value as Result<void>;
}
