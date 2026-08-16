import { lstat, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type Diagnostic, type Result, scanSecrets } from '@dshpack/core';
import { Document, isNode, parseDocument, visit } from 'yaml';

import { writeFileAtomic } from './fs.js';
import {
  settingsIoFailure,
  withSettingsFileLock,
  type YamlSettingsAdapterOptions,
} from './settings-lock.js';

export type { SettingsClock, YamlSettingsAdapterOptions } from './settings-lock.js';
export { withSettingsFileLock } from './settings-lock.js';

export interface SettingsAdapter {
  read(): Promise<Result<Readonly<Record<string, unknown>>>>;
  updateAgentPresets(nextSection: Readonly<Record<string, unknown>>): Promise<Result<void>>;
}

const AGENT_PRESETS = 'agent-presets';

function pass<T>(value: T): Result<T> {
  return { ok: true, value, diagnostics: [] };
}

function fail<T>(diagnostics: readonly Diagnostic[]): Result<T> {
  return { ok: false, diagnostics };
}

function diagnostic(code: string, message: string, hint: string, path: string): Diagnostic {
  return { code, severity: 'error', message, hint, path, evidence: 'local' };
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParsedSettings {
  document: Document;
  root: Record<string, unknown>;
}

export interface PrepareAgentPresetsMergeInput {
  currentDocument: string | undefined;
  fragment: string;
  settingsPath: string;
  fragmentPath: string;
}

export interface PreparedAgentPresetsMerge {
  document: string;
  section: Readonly<Record<string, unknown>>;
}

function parseSettings(source: string, filename: string): Result<ParsedSettings> {
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    const locations = document.errors.map((error) => {
      const at = error.linePos?.[0];
      return `${error.code}${at === undefined ? '' : `@${String(at.line)}:${String(at.col)}`}`;
    });
    return fail([
      diagnostic(
        'E_SETTINGS_INVALID_YAML',
        'settings.yaml 不是有效 YAML，已拒绝覆盖。',
        `先修复 YAML 语法再重试（${locations.join(', ')}）。`,
        filename,
      ),
    ]);
  }

  const value: unknown = document.toJS() ?? {};
  if (!isMap(value)) {
    return fail([
      diagnostic(
        'E_SETTINGS_ROOT',
        'settings.yaml 顶层必须是 namespace map，已拒绝覆盖。',
        '将顶层改为 YAML map 后重试。',
        filename,
      ),
    ]);
  }
  return pass({ document, root: value });
}

function patchNode(
  document: Document,
  path: readonly string[],
  current: unknown,
  next: unknown,
): void {
  if (isMap(current) && isMap(next)) {
    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(next, key)) document.deleteIn([...path, key]);
    }
    for (const [key, value] of Object.entries(next)) {
      patchNode(document, [...path, key], current[key], value);
    }
    return;
  }
  if (!isDeepStrictEqual(current, next)) document.setIn(path, next);
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

function hasAliasBoundary(document: Document): boolean {
  return hasAliasOrAnchor(document.getIn([AGENT_PRESETS], true));
}

function parseFragment(source: string, filename: string): Result<Record<string, unknown>> {
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    return fail([
      diagnostic(
        'E_SETTINGS_FRAGMENT_INVALID_YAML',
        'agent-presets fragment 不是有效 YAML。',
        '修复 settings/agent-presets.yml 的 YAML 语法后重试。',
        filename,
      ),
    ]);
  }
  if (hasAliasOrAnchor(document.contents)) {
    return fail([
      diagnostic(
        'E_SETTINGS_FRAGMENT_ALIAS',
        'agent-presets fragment 含 YAML alias 或 anchor。',
        '展开 fragment 中的 alias/anchor，避免跨边界联动修改。',
        filename,
      ),
    ]);
  }
  const value: unknown = document.toJS() ?? {};
  if (!isMap(value)) {
    return fail([
      diagnostic(
        'E_SETTINGS_FRAGMENT_ROOT',
        'agent-presets fragment 根节点必须是 namespace 的叶 mapping。',
        '直接写 agent-presets 的叶键，不要使用 sequence 或 scalar 根节点。',
        filename,
      ),
    ]);
  }
  if (Object.hasOwn(value, AGENT_PRESETS)) {
    return fail([
      diagnostic(
        'E_SETTINGS_FRAGMENT_NAMESPACE',
        'agent-presets fragment 不得再次包装 agent-presets namespace。',
        '移除顶层 agent-presets:，文件只保留该 namespace 的叶内容。',
        filename,
      ),
    ]);
  }
  return pass(value);
}

/**
 * Purely prepare the exact settings.yaml document that install may later submit to its CAS
 * transaction. The pack file is the `agent-presets` leaf, never a replacement settings document.
 */
export function prepareAgentPresetsMerge(
  input: PrepareAgentPresetsMergeInput,
): Result<PreparedAgentPresetsMerge> {
  const parsed = parseSettings(input.currentDocument ?? '', input.settingsPath);
  if (!parsed.ok || parsed.value === undefined) return fail(parsed.diagnostics);
  if (hasAliasBoundary(parsed.value.document)) {
    return fail([
      diagnostic(
        'E_SETTINGS_ALIAS',
        'agent-presets 含 YAML alias 或 anchor，已拒绝覆盖。',
        '先展开该 namespace 的 alias/anchor，避免修改联动到其他 namespace。',
        input.settingsPath,
      ),
    ]);
  }
  const fragment = parseFragment(input.fragment, input.fragmentPath);
  if (!fragment.ok || fragment.value === undefined) return fail(fragment.diagnostics);
  const secretDiagnostics = scanSecrets({
    path: input.fragmentPath,
    content: input.fragment,
    settingsNamespace: AGENT_PRESETS,
  });
  if (secretDiagnostics.length > 0) return fail(secretDiagnostics);
  patchNode(
    parsed.value.document,
    [AGENT_PRESETS],
    parsed.value.root[AGENT_PRESETS],
    fragment.value,
  );
  return pass({ document: parsed.value.document.toString(), section: fragment.value });
}

async function nearestExistingAncestorIsDirectory(filename: string): Promise<boolean> {
  let candidate = dirname(filename);
  for (;;) {
    try {
      return (await stat(candidate)).isDirectory();
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      try {
        await lstat(candidate);
        return false;
      } catch (linkError) {
        if (!isErrorCode(linkError, 'ENOENT')) throw linkError;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

async function readSource(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') && (await nearestExistingAncestorIsDirectory(filename))) {
      return undefined;
    }
    throw error;
  }
}

/** Atomically replace exact text under the settings writer lock; missing and empty stay distinct. */
export async function compareAndSwapText(
  filename: string,
  expected: string | undefined,
  replacement: string,
  options: YamlSettingsAdapterOptions = {},
): Promise<Result<boolean>> {
  try {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  } catch {
    return settingsIoFailure(filename);
  }
  return withSettingsFileLock(
    filename,
    async () => {
      if ((await readSource(filename)) !== expected) return false;
      await writeFileAtomic(filename, replacement, { mode: 0o600, dirMode: 0o700 });
      return true;
    },
    options,
  );
}

/** Move exact settings text into a transaction-owned backup without overwriting an existing file. */
export async function compareAndMoveText(
  filename: string,
  expected: string,
  destination: string,
  options: YamlSettingsAdapterOptions = {},
): Promise<Result<boolean>> {
  try {
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  } catch {
    return settingsIoFailure(filename);
  }
  return withSettingsFileLock(
    filename,
    async () => {
      if ((await readSource(filename)) !== expected) return false;
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      try {
        await lstat(destination);
        throw Object.assign(new Error('backup destination already exists'), { code: 'EEXIST' });
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) throw error;
      }
      // The destination lives below this transaction's exclusive 0700 backup root. The existence
      // guard therefore cannot be raced by another protocol participant before the atomic rename.
      await rename(filename, destination);
      return true;
    },
    options,
  );
}

/**
 * Comment-preserving settings.yaml adapter for the v0 `agent-presets` namespace.
 * Reads remain lock-free and see either complete pre- or post-rename content. Writers re-read under
 * one cross-process lock, so changes in other namespaces are preserved; concurrent full writes to
 * `agent-presets` remain intentionally last-write-wins. Recursive map edits retain untouched map
 * comments, while replacing an array or scalar also discards comments internal to that old value.
 */
export class YamlSettingsAdapter implements SettingsAdapter {
  readonly #lockOptions: YamlSettingsAdapterOptions;

  constructor(
    readonly filename: string,
    options: YamlSettingsAdapterOptions = {},
  ) {
    this.#lockOptions = { ...options };
  }

  async read(): Promise<Result<Readonly<Record<string, unknown>>>> {
    try {
      const source = await readSource(this.filename);
      if (source === undefined) return pass({});
      const parsed = parseSettings(source, this.filename);
      if (!parsed.ok || parsed.value === undefined) return fail(parsed.diagnostics);
      return pass(parsed.value.root);
    } catch {
      return settingsIoFailure(this.filename);
    }
  }

  async updateAgentPresets(nextSection: Readonly<Record<string, unknown>>): Promise<Result<void>> {
    try {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
      const locked = await withSettingsFileLock(
        this.filename,
        () => this.updateAgentPresetsUnderLock(nextSection),
        this.#lockOptions,
      );
      if (!locked.ok || locked.value === undefined) return fail(locked.diagnostics);
      return locked.value;
    } catch {
      return settingsIoFailure(this.filename);
    }
  }

  private async updateAgentPresetsUnderLock(
    nextSection: Readonly<Record<string, unknown>>,
  ): Promise<Result<void>> {
    const source = await readSource(this.filename);
    const parsed = parseSettings(source ?? '', this.filename);
    if (!parsed.ok || parsed.value === undefined) return fail(parsed.diagnostics);
    if (hasAliasBoundary(parsed.value.document)) {
      return fail([
        diagnostic(
          'E_SETTINGS_ALIAS',
          'agent-presets 含 YAML alias 或 anchor，已拒绝覆盖。',
          '先展开该 namespace 的 alias/anchor，避免修改联动到其他 namespace。',
          this.filename,
        ),
      ]);
    }

    patchNode(
      parsed.value.document,
      [AGENT_PRESETS],
      parsed.value.root[AGENT_PRESETS],
      nextSection,
    );
    const output = parsed.value.document.toString();
    const candidate = new Document({ [AGENT_PRESETS]: nextSection }).toString();
    const secretDiagnostics = scanSecrets({
      path: `${this.filename}#${AGENT_PRESETS}`,
      content: candidate,
      settingsNamespace: AGENT_PRESETS,
    });
    if (secretDiagnostics.length > 0) return fail(secretDiagnostics);

    await writeFileAtomic(this.filename, output, { mode: 0o600, dirMode: 0o700 });
    return pass(undefined);
  }
}
