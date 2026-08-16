import { describe, expect, it } from 'vitest';

import { inspectSkill } from '../src/index.js';

const validSkill = `---
name: browser-debug
description: Diagnose browser problems.
whenToUse: When browser tooling fails.
disable-model-invocation: false
user-invocable: true
---

# Browser debugging
`;

describe('DSH skill frontmatter lint', () => {
  it('accepts DSH-supported frontmatter', () => {
    expect(inspectSkill(validSkill, 'skills/browser-debug/SKILL.md')).toEqual([]);
  });

  it.each([
    ['name', `---\ndescription: A skill\n---\nbody\n`],
    ['description', `---\nname: demo-skill\n---\nbody\n`],
    ['frontmatter', '# no frontmatter\n'],
  ])('reports DSH010 for missing %s because dsh silently drops the skill', (_field, markdown) => {
    expect(inspectSkill(markdown, 'skills/demo-skill/SKILL.md')).toEqual([
      expect.objectContaining({
        code: 'DSH010',
        severity: 'error',
        hint: expect.stringContaining('目录名'),
        evidence: 'official',
      }),
    ]);
  });

  it('reports DSH011 for Claude-style when_to_use', () => {
    const markdown = validSkill.replace('whenToUse', 'when_to_use');
    expect(inspectSkill(markdown, 'skills/browser-debug/SKILL.md')).toEqual([
      expect.objectContaining({
        code: 'DSH011',
        severity: 'warning',
        hint: expect.stringContaining('whenToUse'),
      }),
    ]);
  });

  it.each(['disableModelInvocation', 'modelInvocable', 'userInvocable'])(
    'reports DSH012 for rejected camelCase invocation key %s',
    (key) => {
      const markdown = validSkill.replace('disable-model-invocation', key);
      expect(inspectSkill(markdown, 'skills/browser-debug/SKILL.md')).toEqual([
        expect.objectContaining({
          code: 'DSH012',
          severity: 'error',
          hint: expect.stringContaining(
            key === 'userInvocable' ? 'user-invocable' : 'disable-model-invocation',
          ),
        }),
      ]);
    },
  );

  it.each([
    ['invalid name', validSkill.replace('browser-debug', 'Browser_Debug')],
    ['nested bundle', validSkill, 'skills/category/browser-debug/SKILL.md'],
    ['duplicate name', validSkill, 'skills/browser-debug/SKILL.md', ['browser-debug']],
  ])(
    'reports DSH013 for %s',
    (_name, markdown, path = 'skills/browser-debug/SKILL.md', existingNames: readonly string[] = []) => {
      expect(inspectSkill(markdown, path, { existingNames })).toEqual([
        expect.objectContaining({ code: 'DSH013', severity: 'error', evidence: 'official' }),
      ]);
    },
  );
});
