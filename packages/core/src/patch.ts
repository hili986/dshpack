import { stringify } from 'yaml';

import type { Diagnostic, Result, Severity } from './contracts.js';
import { parseCanonicalYaml } from './pack.js';

export type CanonicalEntry = Record<string, unknown>;
export type PatchEntry = Record<string, unknown>;

const supportedEntryKeys = new Set([
  'id',
  'name',
  'config',
  'group',
  'disabled',
  'inject',
  'intercept',
  'isolate',
]);

function diagnostic(
  code: string,
  severity: Severity,
  message: string,
  hint: string,
  evidence: Diagnostic['evidence'],
  path?: string,
): Diagnostic {
  return {
    code,
    severity,
    message,
    hint,
    evidence,
    ...(path === undefined ? {} : { path }),
  };
}

function success<T>(value: T, diagnostics: readonly Diagnostic[] = []): Result<T> {
  return { ok: true, value, diagnostics };
}

function failure<T>(diagnostics: readonly Diagnostic[]): Result<T> {
  return { ok: false, diagnostics };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function propertyEqual(left: CanonicalEntry, right: CanonicalEntry, key: string): boolean {
  const leftHas = hasOwn(left, key);
  return leftHas === hasOwn(right, key) && (!leftHas || deepEqual(left[key], right[key]));
}

function invalidEntry(path: string, message = 'patch 条目必须是 YAML mapping。'): Diagnostic {
  return diagnostic(
    'E_PATCH_INVALID_ENTRY',
    'error',
    message,
    '改为 Loader 接受的 mapping，并检查 insert 必须是 mapping 数组。',
    'official',
    path,
  );
}

function validateEntryTree(entries: readonly unknown[], path: string): Diagnostic | undefined {
  for (const [index, entry] of entries.entries()) {
    const entryPath = `${path}/${index}`;
    if (!isRecord(entry)) return invalidEntry(entryPath);
    if (hasOwn(entry, 'id') && typeof entry.id !== 'string') {
      return invalidEntry(`${entryPath}/id`, 'patch 的 id 必须是字符串。');
    }
    if (entry.group && Array.isArray(entry.config)) {
      const nested = validateEntryTree(entry.config, `${entryPath}/config`);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function validatePatchList(patches: readonly unknown[]): Diagnostic | undefined {
  for (const [index, patch] of patches.entries()) {
    const path = `/patch/${index}`;
    if (!isRecord(patch)) return invalidEntry(path);
    if (hasOwn(patch, 'id') && typeof patch.id !== 'string') {
      return invalidEntry(`${path}/id`, 'patch 的 id 必须是字符串。');
    }
    if (patch.insert) {
      if (!Array.isArray(patch.insert)) {
        return invalidEntry(`${path}/insert`, 'patch 的 insert 必须是数组。');
      }
      const nested = validateEntryTree(patch.insert, `${path}/insert`);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Reproduce one official apply call relative to the supplied materialized base.
 * Source: deepseek_harness/vendor/include/src/index.ts:43-127 at 47f9438.
 * The id index is built once, then extended only by insert; config replacement
 * deliberately does not re-index children (official regression:
 * deepseek_harness/packages/boot/app-boot/tests/config-dump.spec.ts:104-136).
 */
export function composePatch(
  base: readonly unknown[],
  patches: readonly unknown[],
): Result<CanonicalEntry[]> {
  const baseIssue = validateEntryTree(base, '/base');
  if (baseIssue !== undefined) return failure([baseIssue]);
  const patchIssue = validatePatchList(patches);
  if (patchIssue !== undefined) return failure([patchIssue]);

  let data: CanonicalEntry[];
  let detachedPatches: PatchEntry[];
  try {
    data = clone(base) as CanonicalEntry[];
    detachedPatches = clone(patches) as PatchEntry[];
  } catch {
    return failure([invalidEntry('/patch', 'patch 含无法安全复制的非 YAML 值。')]);
  }
  const diagnostics: Diagnostic[] = [];
  const entries = new Map<string, CanonicalEntry>();
  const index = (rows: readonly CanonicalEntry[]): void => {
    for (const row of rows) {
      if (typeof row.id === 'string' && row.id !== '') entries.set(row.id, row);
      if (row.group && Array.isArray(row.config)) index(row.config as CanonicalEntry[]);
    }
  };
  index(data);

  for (const [patchIndex, patch] of detachedPatches.entries()) {
    const { id, insert, name, ...overrides } = patch;
    const path = `/patch/${patchIndex}`;
    if (insert) {
      const inserted = insert as CanonicalEntry[];
      if (typeof id === 'string' && id !== '') {
        const target = entries.get(id);
        if (target === undefined) {
          diagnostics.push(
            diagnostic(
              'W_PATCH_EXTERNAL_BASELINE',
              'warning',
              `patch 目标 “${id}” 不在当前基线。`,
              '保留原 patch，并在安装后用真实 dump 验证目标 surface。',
              'official',
              `${path}/id`,
            ),
          );
          continue;
        }
        if (!target.group) {
          diagnostics.push(
            diagnostic(
              'W_PATCH_TARGET_NOT_GROUP',
              'warning',
              `patch insert 目标 “${id}” 不是 group。`,
              '改为顶层 insert，或核对目标 group。',
              'official',
              `${path}/id`,
            ),
          );
          continue;
        }
        if (!Array.isArray(target.config)) target.config = [];
        (target.config as unknown[]).push(...inserted);
      } else {
        data.push(...inserted);
      }
      index(inserted);
      continue;
    }

    if (typeof id !== 'string' || id === '') {
      diagnostics.push(
        diagnostic(
          'W_PATCH_MISSING_ID',
          'warning',
          '非 insert patch 缺少 id，官方 Loader 会跳过它。',
          '补充目标 id，或保留原 patch 走 opaque 导出。',
          'official',
          path,
        ),
      );
      continue;
    }
    const target = entries.get(id);
    if (target === undefined) {
      diagnostics.push(
        diagnostic(
          'W_PATCH_EXTERNAL_BASELINE',
          'warning',
          `patch 目标 “${id}” 不在当前基线。`,
          '保留原 patch，并在安装后用真实 dump 验证目标 surface。',
          'official',
          `${path}/id`,
        ),
      );
      continue;
    }
    if (name && name !== target.name) {
      diagnostics.push(
        diagnostic(
          'W_PATCH_NAME_MISMATCH',
          'warning',
          `patch 目标 “${id}” 的 name guard 不匹配。`,
          '核对基线插件名；官方 Loader 会跳过此 patch。',
          'official',
          `${path}/name`,
        ),
      );
      continue;
    }
    for (const [key, value] of Object.entries(overrides)) target[key] = value;
  }
  return success(data, diagnostics);
}

function unknownForm(message: string, path?: string): Result<PatchEntry[]> {
  return failure([
    diagnostic(
      'E_PATCH_UNKNOWN_FORM',
      'error',
      message,
      '保留原始 profile patch，使用 opaque-profile-patch。',
      'local',
      path,
    ),
  ]);
}

function canonicalRows(rows: readonly unknown[], path: string): Result<CanonicalEntry[]> {
  const issue = validateEntryTree(rows, path);
  if (issue !== undefined) return failure([issue]);
  let cloned: CanonicalEntry[];
  try {
    cloned = clone(rows) as CanonicalEntry[];
  } catch {
    return unknownForm('基线或 desired 含无法安全复制的非 YAML 值。', path);
  }
  const ids = new Set<string>();
  for (const [index, row] of cloned.entries()) {
    if (typeof row.id !== 'string' || row.id === '' || ids.has(row.id)) {
      return unknownForm(
        '基线或 desired 含缺失/重复 id，无法证明最小 patch。',
        `${path}/${index}/id`,
      );
    }
    ids.add(row.id);
  }
  return success(cloned);
}

/** Emit the §4.2 safe subset, then serialize, reparse, compose, and assert exact round-trip. */
export function emitMinimalWholeRowPatch(
  base: readonly unknown[],
  desired: readonly unknown[],
): Result<PatchEntry[]> {
  const baseRows = canonicalRows(base, '/base');
  if (!baseRows.ok || baseRows.value === undefined) return failure(baseRows.diagnostics);
  const desiredRows = canonicalRows(desired, '/desired');
  if (!desiredRows.ok || desiredRows.value === undefined) return failure(desiredRows.diagnostics);
  const baseById = new Map(baseRows.value.map((row) => [row.id as string, row]));
  const emitted: PatchEntry[] = [];

  for (const [index, row] of desiredRows.value.entries()) {
    const id = row.id as string;
    const baseline = baseById.get(id);
    if (baseline === undefined) {
      if (!(typeof row.name === 'string' && row.name !== '') && row.group !== true) {
        return failure([
          diagnostic(
            'E_PATCH_UNKNOWN_BASELINE',
            'error',
            `desired 行 “${id}” 像 target override，但基线不存在该 id。`,
            '若它是新插件，请提供完整 name/group 行；否则保留原 patch 走 opaque。',
            'local',
            `/desired/${index}/id`,
          ),
        ]);
      }
      emitted.push({ insert: [clone(row)] });
      continue;
    }
    const keys = new Set([...Object.keys(baseline), ...Object.keys(row)]);
    for (const key of keys) {
      if (key === 'config' || key === 'disabled') continue;
      if (!supportedEntryKeys.has(key) || !propertyEqual(baseline, row, key)) {
        return unknownForm(
          `desired 行 “${id}” 改动了最小 emitter 不支持的字段 “${key}”。`,
          `/desired/${index}/${key}`,
        );
      }
    }
    const change: PatchEntry = { id };
    if (!propertyEqual(baseline, row, 'config') && hasOwn(row, 'config')) {
      change.config = clone(row.config);
    }
    if (!propertyEqual(baseline, row, 'disabled') && hasOwn(row, 'disabled')) {
      change.disabled = clone(row.disabled);
    }
    if (Object.keys(change).length > 1) emitted.push(change);
  }

  let reparsed: ReturnType<typeof parseCanonicalYaml>;
  try {
    reparsed = parseCanonicalYaml(stringify(emitted, { lineWidth: 0 }), { allowJsTag: true });
  } catch {
    return unknownForm('最小 patch 含无法无损序列化的值。');
  }
  const reparsedPatch = reparsed.value?.value;
  const composed = Array.isArray(reparsedPatch)
    ? composePatch(baseRows.value, reparsedPatch)
    : failure<CanonicalEntry[]>(reparsed.diagnostics);
  if (
    !composed.ok ||
    composed.value === undefined ||
    !deepEqual(composed.value, desiredRows.value)
  ) {
    return failure([
      diagnostic(
        'E_PATCH_ROUND_TRIP',
        'error',
        '最小 patch 的 compose 往返断言失败。',
        '不要写入推测结果；保留原始 profile patch。',
        'local',
      ),
    ]);
  }
  return success(emitted);
}
