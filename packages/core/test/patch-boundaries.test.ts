import { describe, expect, it } from 'vitest';

import { composePatch, emitMinimalWholeRowPatch, preparePatchExport } from '../src/index.js';

describe('patch defensive boundaries', () => {
  it.each([
    ['non-string base id', [{ id: 1 }], []],
    ['non-mapping patch', [], [null]],
    ['non-string patch id', [], [{ id: 1, disabled: true }]],
    ['invalid nested base row', [{ id: 'g', name: 'g', group: true, config: [null] }], []],
    ['invalid inserted row', [], [{ insert: [null] }]],
  ])('returns a diagnostic for %s', (_name, base, patch) => {
    expect(composePatch(base, patch)).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_PATCH_INVALID_ENTRY' })],
    });
  });

  it('covers official skipped inserts, missing ids, and an existing group config array', () => {
    const result = composePatch(
      [{ name: 'unindexed' }, { id: 'g', name: 'group', group: true, config: [] }],
      [
        { id: 'missing', insert: [] },
        { id: 'g', insert: [{ id: 'child', name: 'child-plugin' }] },
        { config: { ignored: true } },
      ],
    );
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'W_PATCH_EXTERNAL_BASELINE',
      'W_PATCH_MISSING_ID',
    ]);
  });

  it('shallow-overwrites every open PatchOptions field outside id/insert/name', () => {
    const result = composePatch(
      [{ id: 'open', name: 'open-plugin', inject: { old: true } }],
      [{ id: 'open', inject: { next: true }, futureOfficialField: { literal: true } }],
    );
    expect(result.value).toEqual([
      {
        id: 'open',
        name: 'open-plugin',
        inject: { next: true },
        futureOfficialField: { literal: true },
      },
    ]);
  });

  it('returns Result diagnostics for non-cloneable pure API values', () => {
    expect(
      composePatch([{ id: 'bad', name: 'bad-plugin', config: () => undefined }], []).diagnostics[0]
        ?.code,
    ).toBe('E_PATCH_INVALID_ENTRY');
    expect(
      emitMinimalWholeRowPatch([], [{ id: 'bad', name: 'bad-plugin', config: () => undefined }])
        .diagnostics[0]?.code,
    ).toBe('E_PATCH_UNKNOWN_FORM');
  });

  it('rejects invalid and duplicate rows in either emitter input', () => {
    expect(emitMinimalWholeRowPatch([null], []).diagnostics[0]?.code).toBe('E_PATCH_INVALID_ENTRY');
    expect(
      emitMinimalWholeRowPatch(
        [{ id: 'duplicate', name: 'a' }],
        [
          { id: 'duplicate', name: 'a' },
          { id: 'duplicate', name: 'b' },
        ],
      ).diagnostics[0]?.code,
    ).toBe('E_PATCH_UNKNOWN_FORM');
  });

  it('rejects a cyclic value that YAML cannot serialize', () => {
    const config: Record<string, unknown> = {};
    config.self = config;
    expect(
      emitMinimalWholeRowPatch([], [{ id: 'cyclic', name: 'cyclic-plugin', config }]).diagnostics[0]
        ?.code,
    ).toBe('E_PATCH_ROUND_TRIP');
  });

  it.each([
    ['invalid YAML', 'invalid: [unclosed\n', 'E_PATCH_PARSE'],
    ['explicit null', 'null\n', 'E_PATCH_EMPTY_LAYER'],
    ['mapping root', 'id: not-an-array\n', 'E_PATCH_INVALID_ENTRY'],
    ['scalar entry', '- scalar\n', 'E_PATCH_INVALID_ENTRY'],
  ])('rejects %s profile input', (_name, profile, code) => {
    expect(preparePatchExport('[]\n', profile).diagnostics[0]?.code).toBe(code);
  });

  it.each([
    ['non-mapping inserted row', '- insert:\n    - scalar\n'],
    ['inserted row missing id', '- insert:\n    - name: missing-id\n'],
    ['invalid materialized base row', '[]\n'],
  ])('falls back when compose/emit cannot prove %s', (name, profile) => {
    const base = name === 'invalid materialized base row' ? '- null\n' : '[]\n';
    expect(preparePatchExport(base, profile).value?.exportMode).toBe('opaque-profile-patch');
  });

  it('supports targeting a nested id introduced by an earlier profile insert', () => {
    const profile = `- insert:
    - id: own-group
      name: group-plugin
      group: true
      config:
        - id: own-child
          name: child-plugin
- id: own-child
  disabled: true
`;
    expect(preparePatchExport('[]\n', profile)).toEqual({
      ok: true,
      value: {
        exportMode: 'minimal-whole-row',
        patch: [
          {
            insert: [
              {
                id: 'own-group',
                name: 'group-plugin',
                group: true,
                config: [{ id: 'own-child', name: 'child-plugin', disabled: true }],
              },
            ],
          },
        ],
      },
      diagnostics: [],
    });
  });
});
