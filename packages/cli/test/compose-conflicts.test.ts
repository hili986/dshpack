import { describe, expect, it } from 'vitest';

import { resolveComposeConflicts } from '../src/compose/conflicts.js';
import type { ComposeSourceItem } from '../src/compose/schema.js';

function item(id: string, from: string, text = id): ComposeSourceItem {
  return {
    bytes: Buffer.from(text),
    from,
    id,
    license: 'MIT',
    originalPath: `skills/${id}/SKILL.md`,
    sourcePath: 'SKILL.md',
  };
}

describe('compose conflict resolution', () => {
  it('rejects every unresolved cross-source id rather than silently overwriting any', () => {
    const report = resolveComposeConflicts(
      [
        item('citation', 'profile:research'),
        item('citation', 'github:team/a#0123456789abcdef0123456789abcdef01234567'),
        item('outline', 'profile:research'),
        item('outline', './local-pack'),
      ],
      [],
    );

    expect(report.items).toEqual([]);
    expect(report.diagnostics).toHaveLength(2);
    expect(report.diagnostics.map(({ path }) => path)).toEqual(['citation', 'outline']);
    expect(report.diagnostics.map(({ message }) => message).join('\n')).toContain(
      'profile:research',
    );
    expect(report.diagnostics.map(({ message }) => message).join('\n')).toContain('./local-pack');
  });

  it('renames one explicit source item while preserving both source byte payloads', () => {
    const original = Buffer.from('unchanged skill content');
    const report = resolveComposeConflicts(
      [
        { ...item('citation', 'profile:research'), bytes: original },
        item('citation', './local-pack', 'local content'),
      ],
      [{ id: 'citation', rename: 'profile-citation' }],
    );

    expect(report.diagnostics).toEqual([expect.objectContaining({ code: 'W_COMPOSE_RENAME' })]);
    expect(report.items.map(({ id }) => id).sort()).toEqual(['citation', 'profile-citation']);
    expect(report.items.find(({ id }) => id === 'profile-citation')?.bytes).toBe(original);
  });

  it('applies an explicit rename even when the selected skill has no competing source', () => {
    const original = item(
      'commit-convention',
      'github:dsh-packs/web-dev#3414f1af3fd674998cea81716586f4716a538f50',
      'unchanged content',
    );
    const report = resolveComposeConflicts(
      [original],
      [{ id: 'commit-convention', rename: 'web-commit-convention' }],
    );

    expect(report.diagnostics).toEqual([expect.objectContaining({ code: 'W_COMPOSE_RENAME' })]);
    expect(report.items).toEqual([{ ...original, id: 'web-commit-convention' }]);
  });

  it('uses prefer to retain only the explicit source and reports the discarded candidate', () => {
    const selected = item('citation', './local-pack', 'local content');
    const report = resolveComposeConflicts(
      [item('citation', 'profile:research'), selected],
      [{ id: 'citation', prefer: './local-pack' }],
    );

    expect(report.items).toEqual([selected]);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: 'W_COMPOSE_PREFER',
        message: expect.stringContaining('profile:research'),
      }),
    ]);
  });
});
