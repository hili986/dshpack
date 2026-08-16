import { isMap, isNode, isScalar, isSeq } from 'yaml';

import type { Diagnostic, Result } from './contracts.js';
import { parseCanonicalYaml } from './pack.js';
import { composePatch, emitMinimalWholeRowPatch, type PatchEntry } from './patch.js';

export type PatchExport =
  | { exportMode: 'minimal-whole-row'; patch: PatchEntry[] }
  | { exportMode: 'opaque-profile-patch'; patch: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function issue(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  hint: string,
  evidence: Diagnostic['evidence'],
  path?: string,
): Diagnostic {
  return { code, severity, message, hint, evidence, ...(path === undefined ? {} : { path }) };
}

function success(value: PatchExport, diagnostics: readonly Diagnostic[] = []): Result<PatchExport> {
  return { ok: true, value, diagnostics };
}

function failure(diagnostic: Diagnostic): Result<PatchExport> {
  return { ok: false, diagnostics: [diagnostic] };
}

function invalidEntry(path: string, message = 'patch 条目必须是 YAML mapping。'): Diagnostic {
  return issue(
    'E_PATCH_INVALID_ENTRY',
    'error',
    message,
    '改为 Loader 接受的 mapping；合法空层必须写成 []。',
    'official',
    path,
  );
}

function containsJsTag(node: unknown): boolean {
  if (!isNode(node)) return false;
  if (node.tag === 'tag:yaml.org,2002:js') return true;
  if (isMap(node)) {
    return node.items.some((pair) => containsJsTag(pair.key) || containsJsTag(pair.value));
  }
  return isSeq(node) && node.items.some(containsJsTag);
}

type TaggedPatchField = 'config' | 'disabled';

function taggedFieldsById(node: unknown): Map<string, ReadonlySet<TaggedPatchField>> {
  const tagged = new Map<string, ReadonlySet<TaggedPatchField>>();
  if (!isSeq(node)) return tagged;
  for (const row of node.items) {
    if (!isMap(row)) continue;
    let id: string | undefined;
    const fields = new Set<TaggedPatchField>();
    for (const pair of row.items) {
      if (!isScalar(pair.key)) continue;
      if (pair.key.value === 'id' && isScalar(pair.value) && typeof pair.value.value === 'string') {
        id = pair.value.value;
      }
      if (
        (pair.key.value === 'config' || pair.key.value === 'disabled') &&
        containsJsTag(pair.value)
      ) {
        fields.add(pair.key.value);
      }
    }
    if (id !== undefined && fields.size > 0) tagged.set(id, fields);
  }
  return tagged;
}

function touchesTaggedField(
  patches: readonly unknown[],
  tagged: ReadonlyMap<string, ReadonlySet<TaggedPatchField>>,
): boolean {
  return patches.some((patch) => {
    if (!isRecord(patch) || typeof patch.id !== 'string') return false;
    const fields = tagged.get(patch.id);
    return fields !== undefined && [...fields].some((field) => hasOwn(patch, field));
  });
}

function portableProfileForm(patches: readonly unknown[]): boolean {
  return patches.every((value) => {
    if (!isRecord(value)) return false;
    const keys = Object.keys(value);
    if (hasOwn(value, 'insert')) return keys.length === 1 && Array.isArray(value.insert);
    return (
      typeof value.id === 'string' &&
      value.id !== '' &&
      keys.every((key) => key === 'id' || key === 'config' || key === 'disabled') &&
      (hasOwn(value, 'config') || hasOwn(value, 'disabled'))
    );
  });
}

function addEntryIds(rows: readonly unknown[], ids: Set<string>): void {
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (typeof row.id === 'string' && row.id !== '') ids.add(row.id);
    if (row.group && Array.isArray(row.config)) addEntryIds(row.config, ids);
  }
}

function externalTargets(base: readonly unknown[], patches: readonly unknown[]): Diagnostic[] {
  // dump-default is materialized, but real boot flattens raw layers into one apply call.
  // Only top-level ids are provable:
  // deepseek_harness/packages/boot/app-boot/tests/config-dump.spec.ts:104-136.
  const known = new Set<string>();
  for (const row of base) {
    if (isRecord(row) && typeof row.id === 'string' && row.id !== '') known.add(row.id);
  }
  const diagnostics: Diagnostic[] = [];
  for (const [index, patch] of patches.entries()) {
    if (!isRecord(patch)) continue;
    if (Array.isArray(patch.insert)) {
      addEntryIds(patch.insert, known);
    } else if (typeof patch.id === 'string' && !known.has(patch.id)) {
      diagnostics.push(
        issue(
          'W_PATCH_EXTERNAL_BASELINE',
          'warning',
          `patch 目标 “${patch.id}” 不是可证明的基线顶层行。`,
          '保留原 patch，并在安装后用真实 dump 验证。',
          'official',
          `/patch/${index}/id`,
        ),
      );
    }
  }
  return diagnostics;
}

function opaque(
  profilePatch: string,
  reason: string,
  before: readonly Diagnostic[] = [],
): Result<PatchExport> {
  return success({ exportMode: 'opaque-profile-patch', patch: profilePatch }, [
    ...before,
    issue(
      'W_PATCH_OPAQUE',
      'warning',
      `无法证明最小 patch 无损：${reason}`,
      '原样保留 profile patch，并在安装后执行真实 dump 验证。',
      'local',
    ),
  ]);
}

/**
 * Prepare export without evaluating !!js or losing unsupported Loader forms.
 * Dialect source: deepseek_harness/vendor/include/src/index.ts:9-25,145-156 at 47f9438.
 */
export function preparePatchExport(
  defaultDumpYaml: string,
  profilePatchYaml: string,
): Result<PatchExport> {
  if (profilePatchYaml.split('\n').every((line) => /^\s*(?:#.*)?$/u.test(line))) {
    return failure(
      issue(
        'E_PATCH_EMPTY_LAYER',
        'error',
        'profile patch 为空或只有注释。',
        '合法空层必须显式写成 []。',
        'official',
      ),
    );
  }
  const profile = parseCanonicalYaml(profilePatchYaml, { allowJsTag: true });
  if (!profile.ok || profile.value === undefined) {
    return failure(
      issue(
        'E_PATCH_PARSE',
        'error',
        'profile patch YAML 无法解析。',
        '修正语法；合法空层必须写成 []。',
        'official',
      ),
    );
  }
  if (profile.value.value === null) {
    return failure(
      issue(
        'E_PATCH_EMPTY_LAYER',
        'error',
        'profile patch 为空或只有注释。',
        '合法空层必须显式写成 []。',
        'official',
      ),
    );
  }
  if (!Array.isArray(profile.value.value)) {
    return failure(invalidEntry('/patch', 'profile patch 顶层必须是数组。'));
  }
  const nonMapping = profile.value.value.findIndex((entry) => !isRecord(entry));
  if (nonMapping >= 0) return failure(invalidEntry(`/patch/${nonMapping}`));
  if (containsJsTag(profile.value.document.contents)) {
    return opaque(profilePatchYaml, '相关 !!js 标量的原始字节不能由通用 YAML emitter 证明稳定');
  }
  if (!portableProfileForm(profile.value.value)) {
    return opaque(profilePatchYaml, 'profile 使用了 config/disabled/顶层 insert 之外的官方 form');
  }

  const base = parseCanonicalYaml(defaultDumpYaml, { allowJsTag: true });
  if (!base.ok || !Array.isArray(base.value?.value)) {
    return opaque(profilePatchYaml, 'dump-default-config 无法解析为顶层 entry 数组');
  }
  // yaml Document keeps !!js while toJS() erases the tag. Track the affected
  // top-level config/disabled fields from the official dialect
  // (deepseek_harness/vendor/include/src/index.ts:9-25, loader/src/config/entry.ts:100-112).
  if (touchesTaggedField(profile.value.value, taggedFieldsById(base.value.document.contents))) {
    return opaque(
      profilePatchYaml,
      'profile 触及含 !!js 的 baseline config/disabled 字段，标量 tag 无法证明无损',
    );
  }
  const external = externalTargets(base.value.value, profile.value.value);
  if (external.length > 0) {
    return opaque(profilePatchYaml, '存在无法由 materialized baseline 证明的 target id', external);
  }
  const desired = composePatch(base.value.value, profile.value.value);
  if (!desired.ok || desired.value === undefined || desired.diagnostics.length > 0) {
    return opaque(profilePatchYaml, '官方 compose 语义产生跳过项或不可验证项', desired.diagnostics);
  }
  const emitted = emitMinimalWholeRowPatch(base.value.value, desired.value);
  if (!emitted.ok || emitted.value === undefined) {
    return opaque(profilePatchYaml, emitted.diagnostics[0]?.code ?? '往返断言失败');
  }
  return success({ exportMode: 'minimal-whole-row', patch: emitted.value });
}
