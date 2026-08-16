import matter from 'gray-matter';

import type { Diagnostic } from './contracts.js';

export interface SkillInspectionOptions {
  existingNames?: readonly string[];
}

const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const rejectedInvocationKeys = new Map<string, string>([
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
]);

function diagnostic(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  hint: string,
  path: string,
): Diagnostic {
  return { code, severity, message, hint, path, evidence: 'official' };
}

function directoryName(path: string): string {
  const segments = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0);
  const leaf = segments.at(-1) ?? 'skill';
  if (leaf === 'SKILL.md') return segments.at(-2) ?? 'skill';
  return leaf.endsWith('.md') ? leaf.slice(0, -3) : leaf;
}

function isNestedBundle(path: string): boolean {
  const segments = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment.length > 0);
  const skillsAt = segments.lastIndexOf('skills');
  return skillsAt >= 0 && segments.at(-1) === 'SKILL.md' && segments.length - skillsAt > 3;
}

/**
 * Lint the DSH filesystem skill format without reading disk.
 *
 * Official behavior: `deepseek_harness/packages/skill/skill-filesystem/src/index.ts:802-825`
 * silently skips absent name/description and invalid frontmatter; `:992-1028` rejects legacy
 * camelCase invocation keys. Direct one-level discovery is at `:719-731`.
 */
export function inspectSkill(
  markdown: string,
  path: string,
  options: SkillInspectionOptions = {},
): readonly Diagnostic[] {
  if (!markdown.startsWith('---')) {
    return [
      diagnostic(
        'DSH010',
        'error',
        'skill 缺少 YAML frontmatter，dsh 会静默丢弃该 skill。',
        `从目录名 “${directoryName(path)}” 补 name，并补充 description。`,
        path,
      ),
    ];
  }

  let data: Record<string, unknown>;
  try {
    data = matter(markdown).data as Record<string, unknown>;
  } catch {
    return [
      diagnostic(
        'DSH010',
        'error',
        'skill frontmatter 不能解析，dsh 会静默丢弃该 skill。',
        `从目录名 “${directoryName(path)}” 重建 name 与 description frontmatter。`,
        path,
      ),
    ];
  }

  const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : undefined;
  const description =
    typeof data.description === 'string' && data.description.length > 0
      ? data.description
      : undefined;
  if (name === undefined || description === undefined) {
    return [
      diagnostic(
        'DSH010',
        'error',
        'skill 缺少 name 或 description，dsh 会静默丢弃该 skill。',
        `从目录名 “${directoryName(path)}” 补 name，并补充 description。`,
        path,
      ),
    ];
  }

  if (Object.hasOwn(data, 'when_to_use')) {
    return [
      diagnostic(
        'DSH011',
        'warning',
        'when_to_use 会被 dsh 忽略。',
        '将 when_to_use 改为 whenToUse。',
        path,
      ),
    ];
  }

  for (const [legacy, canonical] of rejectedInvocationKeys) {
    if (Object.hasOwn(data, legacy)) {
      return [
        diagnostic(
          'DSH012',
          'error',
          `${legacy} 会使 dsh 丢弃整个 skill。`,
          `将 ${legacy} 改为 ${canonical}。`,
          path,
        ),
      ];
    }
  }

  if (!skillName.test(name)) {
    return [
      diagnostic(
        'DSH013',
        'error',
        'skill name 必须是 kebab-case。',
        '使用小写字母、数字与单个连字符。',
        path,
      ),
    ];
  }
  if (isNestedBundle(path)) {
    return [
      diagnostic(
        'DSH013',
        'error',
        '嵌套 SKILL.md 不会被 dsh 递归发现。',
        '将 SKILL.md 移到 skills/<name>/SKILL.md。',
        path,
      ),
    ];
  }
  if (options.existingNames?.includes(name) === true) {
    return [
      diagnostic(
        'DSH013',
        'error',
        'skill name 与已有 skill 冲突。',
        '重命名为唯一的 kebab-case name。',
        path,
      ),
    ];
  }
  return [];
}
