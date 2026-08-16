import { basename, dirname } from 'node:path';

import { type Diagnostic, type Result, scanSecrets } from '@dshpack/core';
import { Document, isMap, isNode, parseDocument, visit } from 'yaml';

import { writeFileAtomic } from '../adapters/fs.js';
import {
  settingsIoFailure,
  withSettingsFileLock,
  type YamlSettingsAdapterOptions,
} from '../adapters/settings-lock.js';
import {
  bindSecureRoot,
  type DirectoryBinding,
  readText,
  revalidateDirectory,
  type SafePathHooks,
} from '../list/safe-fs.js';

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

interface SettingsSource {
  text: string;
  root: DirectoryBinding;
}

export interface SelectedPresetUpdateHooks extends SafePathHooks {
  afterPreLockRevalidate?(path: string): Promise<void>;
}

async function ordinarySource(
  path: string,
  hooks: SafePathHooks = {},
): Promise<Result<SettingsSource>> {
  const root = await bindSecureRoot(dirname(path), hooks);
  if (!root.ok)
    return root.kind === 'security'
      ? failure('E_PATH_SETTINGS', root.reason, '移除 symlink、junction 或非目录祖先后重试。', path)
      : settingsIoFailure(path);
  const source = await readText(root.value, [basename(path)], hooks);
  if (!source.ok && source.kind === 'missing') return success({ text: '', root: root.value });
  if (!source.ok && source.kind === 'security')
    return failure(
      'E_PATH_SETTINGS',
      source.reason,
      '移除 symlink、junction 或同名目录后重试。',
      path,
    );
  if (!source.ok) return settingsIoFailure(path);
  return success({ text: source.value.text, root: root.value });
}

interface ParsedAgentPresets {
  document: Document;
  section: Record<string, unknown>;
}

function parseAgentPresets(current: string, path: string): Result<ParsedAgentPresets> {
  let document: Document;
  try {
    document = parseDocument(current.trim() === '' ? '{}\n' : current, { prettyErrors: true });
  } catch {
    return failure(
      'E_SETTINGS_INVALID_YAML',
      'settings.yaml 解析异常，已拒绝覆盖。',
      '先修复 YAML 语法或资源耗尽结构后重试。',
      path,
    );
  }
  if (document.errors.length > 0)
    return failure(
      'E_SETTINGS_INVALID_YAML',
      'settings.yaml 不是有效 YAML，已拒绝覆盖。',
      '先修复 YAML 语法再重试。',
      path,
    );
  if (document.contents !== null && !isMap(document.contents))
    return failure(
      'E_SETTINGS_ROOT',
      'settings.yaml 顶层必须是 namespace map，已拒绝覆盖。',
      '将顶层改为 YAML map 后重试。',
      path,
    );
  const rawSection = document.getIn(['agent-presets'], true);
  if (hasAliasOrAnchor(rawSection))
    return failure(
      'E_SETTINGS_ALIAS',
      'agent-presets 含 YAML alias 或 anchor，已拒绝覆盖。',
      '先展开该 namespace 的 alias/anchor，避免修改联动到其他 namespace。',
      path,
    );
  if (rawSection !== undefined && !isMap(rawSection))
    return failure(
      'E_SWITCH_SETTINGS',
      'settings.yaml 的 agent-presets namespace 必须是 mapping。',
      '修复 settings.yaml 后重试。',
      path,
    );
  let section: Record<string, unknown> = {};
  if (rawSection !== undefined) {
    try {
      const value: unknown = rawSection.toJSON();
      if (!isRecord(value)) throw new TypeError('agent-presets is not a mapping');
      section = value;
    } catch {
      return failure(
        'E_SWITCH_SETTINGS',
        'agent-presets 不能安全转换，已拒绝覆盖。',
        '移除异常 YAML 节点后重试。',
        path,
      );
    }
  }
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
  hooks: SafePathHooks = {},
): Promise<Result<{ selected: unknown; root: DirectoryBinding }>> {
  const current = await ordinarySource(path, hooks);
  if (!current.ok || current.value === undefined)
    return { ok: false, diagnostics: current.diagnostics };
  const parsed = parseAgentPresets(current.value.text, path);
  if (!parsed.ok || parsed.value === undefined)
    return { ok: false, diagnostics: parsed.diagnostics };
  return success({ selected: parsed.value.section.selected, root: current.value.root });
}

async function updateUnderLock(
  path: string,
  preset: string,
  hooks: SafePathHooks,
): Promise<Result<boolean>> {
  const current = await ordinarySource(path, hooks);
  if (!current.ok || current.value === undefined)
    return { ok: false, diagnostics: current.diagnostics };
  const parsed = parseAgentPresets(current.value.text, path);
  if (!parsed.ok || parsed.value === undefined)
    return { ok: false, diagnostics: parsed.diagnostics };
  const { document, section } = parsed.value;
  if (section.selected === preset) return success(false);
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
  const stable = await revalidateDirectory(current.value.root, hooks);
  if (!stable.ok)
    return failure(
      'E_PATH_SETTINGS',
      stable.reason,
      '确认 DSH_HOME 未被替换且不含 symlink 后重试。',
      path,
    );
  await writeFileAtomic(path, document.toString(), { mode: 0o600, dirMode: 0o700 });
  return success(true);
}

/** Lock-scoped leaf RMW: a concurrent writer can never be erased by a stale pre-confirm snapshot. */
export async function updateSelectedPreset(
  path: string,
  preset: string,
  options: YamlSettingsAdapterOptions = {},
  expectedRoot?: DirectoryBinding,
  hooks: SelectedPresetUpdateHooks = {},
): Promise<Result<boolean>> {
  if (expectedRoot !== undefined) {
    const stable = await revalidateDirectory(expectedRoot, hooks);
    if (!stable.ok)
      return failure(
        'E_PATH_SETTINGS',
        stable.reason,
        '确认 DSH_HOME 未被替换且不含 symlink 后重试。',
        path,
      );
  }
  try {
    await hooks.afterPreLockRevalidate?.(path);
  } catch {
    return settingsIoFailure(path);
  }
  const lockOptions: YamlSettingsAdapterOptions =
    expectedRoot === undefined
      ? options
      : {
          ...options,
          beforeLockAcquire: async () => {
            const callerGuard = await options.beforeLockAcquire?.();
            if (callerGuard !== undefined && !callerGuard.ok) return callerGuard;
            const stable = await revalidateDirectory(expectedRoot, hooks);
            return stable.ok
              ? success(undefined)
              : failure(
                  'E_PATH_SETTINGS',
                  stable.reason,
                  '确认 DSH_HOME 未被替换且不含 symlink 后重试。',
                  path,
                );
          },
        };
  const locked = await withSettingsFileLock(
    path,
    () => updateUnderLock(path, preset, hooks),
    lockOptions,
  );
  if (!locked.ok) return { ok: false, diagnostics: locked.diagnostics };
  return locked.value as Result<boolean>;
}
