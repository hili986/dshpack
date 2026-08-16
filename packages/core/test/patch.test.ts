import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  composePatch,
  emitMinimalWholeRowPatch,
  parseCanonicalYaml,
  preparePatchExport,
} from '../src/index.js';

const fixtureRoot = resolve(import.meta.dirname, 'fixtures', 'real-dsh');

async function fixture(path: string): Promise<string> {
  return readFile(resolve(fixtureRoot, path), 'utf8');
}

function parsedRows(source: string): unknown[] {
  const parsed = parseCanonicalYaml(source, { allowJsTag: true });
  expect(parsed.ok).toBe(true);
  expect(Array.isArray(parsed.value?.value)).toBe(true);
  return parsed.value?.value as unknown[];
}

describe('composePatch', () => {
  it('matches the official single-pass index, whole-config replacement, and insert semantics', () => {
    const base = [
      {
        id: 'group',
        name: 'group-plugin',
        group: true,
        config: [{ id: 'old-child', name: 'old-plugin', config: { inherited: true } }],
      },
      { id: 'plain', name: 'plain-plugin', config: { keep: false, replaced: 'base' } },
    ];
    const patch = [
      { id: 'plain', config: { replaced: 'profile' } },
      { insert: [{ id: 'inserted', name: 'new-plugin', config: { value: 1 } }] },
      { id: 'inserted', config: { value: 2 }, disabled: true },
      {
        id: 'group',
        config: [{ id: 'replacement-child', name: 'replacement-plugin', config: { value: 1 } }],
      },
      { id: 'replacement-child', config: { value: 2 } },
    ];

    const result = composePatch(base, patch);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual([
      {
        id: 'group',
        name: 'group-plugin',
        group: true,
        config: [{ id: 'replacement-child', name: 'replacement-plugin', config: { value: 1 } }],
      },
      { id: 'plain', name: 'plain-plugin', config: { replaced: 'profile' } },
      { id: 'inserted', name: 'new-plugin', config: { value: 2 }, disabled: true },
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'W_PATCH_EXTERNAL_BASELINE', severity: 'warning' }),
    ]);
    expect(base[0]?.config).toEqual([
      { id: 'old-child', name: 'old-plugin', config: { inherited: true } },
    ]);
    expect(patch[1]).toEqual({
      insert: [{ id: 'inserted', name: 'new-plugin', config: { value: 1 } }],
    });
  });

  it('skips name mismatches and invalid group inserts like the official Loader', () => {
    const result = composePatch(
      [
        { id: 'plain', name: 'plain-plugin' },
        { id: 'group', name: 'group-plugin', group: true },
      ],
      [
        { id: 'plain', name: 'different-plugin', disabled: true },
        { id: 'plain', insert: [{ id: 'child', name: 'child-plugin' }] },
        { id: 'group', insert: [{ id: 'group-child', name: 'child-plugin' }] },
      ],
    );

    expect(result.ok).toBe(true);
    expect(result.value).toEqual([
      { id: 'plain', name: 'plain-plugin' },
      {
        id: 'group',
        name: 'group-plugin',
        group: true,
        config: [{ id: 'group-child', name: 'child-plugin' }],
      },
    ]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'W_PATCH_NAME_MISMATCH',
      'W_PATCH_TARGET_NOT_GROUP',
    ]);
  });

  it('replaces, rather than deep-merges, a multi-key config from the real E9 dump', async () => {
    const base = parsedRows(await fixture('e9/dump-default-config.yml'));
    const result = composePatch(base, [{ id: 'session-title', config: { maxTitleBytes: 96 } }]);
    const emitted = emitMinimalWholeRowPatch(base, result.value ?? []);
    const equal =
      JSON.stringify(composePatch(base, emitted.value ?? []).value) ===
      JSON.stringify(result.value);

    console.info(
      `W7_REAL_FIXTURE_ROUNDTRIP ${JSON.stringify({
        id: 'session-title',
        desiredConfig: { maxTitleBytes: 96 },
        emittedPatch: emitted.value,
        equal,
      })}`,
    );

    expect(result.ok).toBe(true);
    expect(equal).toBe(true);
    expect(
      (result.value as { id?: string; config?: unknown }[]).find(({ id }) => id === 'session-title')
        ?.config,
    ).toEqual({ maxTitleBytes: 96 });
  });

  it('rejects malformed entry and patch arrays without throwing', () => {
    expect(composePatch([null], []).diagnostics).toEqual([
      expect.objectContaining({ code: 'E_PATCH_INVALID_ENTRY' }),
    ]);
    expect(composePatch([], [{ insert: 'not-an-array' }]).diagnostics).toEqual([
      expect.objectContaining({ code: 'E_PATCH_INVALID_ENTRY' }),
    ]);
  });
});

describe('emitMinimalWholeRowPatch', () => {
  it('emits only full changed configs, disabled changes, and complete appended rows', () => {
    const base = [
      { id: 'same', name: 'same-plugin', config: { value: 1 } },
      { id: 'config', name: 'config-plugin', config: { keep: 'must-not-deep-merge', old: true } },
      { id: 'disabled', name: 'disabled-plugin' },
    ];
    const desired = [
      { id: 'same', name: 'same-plugin', config: { value: 1 } },
      { id: 'config', name: 'config-plugin', config: { complete: 'replacement' } },
      { id: 'disabled', name: 'disabled-plugin', disabled: true },
      { id: 'new', name: 'new-plugin', config: { complete: true } },
    ];

    const emitted = emitMinimalWholeRowPatch(base, desired);

    expect(emitted).toEqual({
      ok: true,
      value: [
        { id: 'config', config: { complete: 'replacement' } },
        { id: 'disabled', disabled: true },
        { insert: [{ id: 'new', name: 'new-plugin', config: { complete: true } }] },
      ],
      diagnostics: [],
    });
    expect(composePatch(base, emitted.value ?? []).value).toEqual(desired);
  });

  it.each([
    ['row deletion', [{ id: 'a', name: 'a-plugin' }], []],
    [
      'row reorder',
      [
        { id: 'a', name: 'a-plugin' },
        { id: 'b', name: 'b-plugin' },
      ],
      [
        { id: 'b', name: 'b-plugin' },
        { id: 'a', name: 'a-plugin' },
      ],
    ],
  ])('lets the final round-trip guard reject %s', (_name, base, desired) => {
    const result = emitMinimalWholeRowPatch(base, desired);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'E_PATCH_ROUND_TRIP' })]);
  });

  it('refuses an unsupported field change before emitting a lossy patch', () => {
    const result = emitMinimalWholeRowPatch(
      [{ id: 'a', name: 'a-plugin', inject: ['old'] }],
      [{ id: 'a', name: 'a-plugin', inject: ['new'] }],
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'E_PATCH_UNKNOWN_FORM' })]);
  });

  it('distinguishes a complete new row from a target-shaped id absent from baseline', () => {
    expect(emitMinimalWholeRowPatch([], [{ id: 'missing', config: { value: 1 } }])).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_PATCH_UNKNOWN_BASELINE' })],
    });
    expect(
      emitMinimalWholeRowPatch(
        [],
        [{ id: 'complete-new-row', name: 'new-plugin', config: { value: 1 } }],
      ).ok,
    ).toBe(true);
  });
});

describe('preparePatchExport', () => {
  it('uses the real E9 default dump and E5 patch to reproduce the real E5 effective dump', async () => {
    const defaultDump = await fixture('e9/dump-default-config.yml');
    const profilePatch = await fixture('e5-mcp/cordis.patch.yml');
    const effectiveDump = await fixture('e5-mcp/dump-config.yml');

    const prepared = preparePatchExport(defaultDump, profilePatch);

    expect(prepared).toEqual({
      ok: true,
      value: {
        exportMode: 'minimal-whole-row',
        patch: [
          {
            insert: [
              {
                id: 'mcp-e5-probe',
                name: '@deepseek-ai/dsh-mcp-client',
                config: {
                  serverName: 'e5probe',
                  transport: 'streamable-http',
                  url: 'http://127.0.0.1:9/mcp',
                  failOnStartupError: true,
                },
              },
            ],
          },
        ],
      },
      diagnostics: [],
    });

    if (prepared.value?.exportMode !== 'minimal-whole-row') {
      throw new Error('E5 portable patch unexpectedly fell back to opaque');
    }
    const composed = composePatch(parsedRows(defaultDump), prepared.value.patch);
    expect(composed.value).toEqual(parsedRows(effectiveDump));
  });

  it('accepts the real E1 legal empty layer and does not treat !!js in untouched E9 base rows as opaque', async () => {
    const result = preparePatchExport(
      await fixture('e9/dump-default-config.yml'),
      await fixture('e1-profile/cordis.patch.yml'),
    );

    expect(result).toEqual({
      ok: true,
      value: { exportMode: 'minimal-whole-row', patch: [] },
      diagnostics: [],
    });
  });

  it.each(['', '   \n', '# comment only\n# still no document\n'])(
    'rejects an empty or comment-only profile layer: %j',
    async (profilePatch) => {
      const result = preparePatchExport(await fixture('e9/dump-default-config.yml'), profilePatch);
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'E_PATCH_EMPTY_LAYER', severity: 'error' }),
      ]);
    },
  );

  it('preserves an unknown baseline target byte-for-byte through opaque fallback', async () => {
    const profilePatch = '# external surface\n- id: only-on-another-surface\n  disabled: true\n';
    const result = preparePatchExport(await fixture('e9/dump-default-config.yml'), profilePatch);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      exportMode: 'opaque-profile-patch',
      patch: profilePatch,
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      'W_PATCH_EXTERNAL_BASELINE',
      'W_PATCH_OPAQUE',
    ]);
  });

  it('treats a nested materialized baseline id as opaque but supports ids inserted earlier by the profile', () => {
    const base = `- id: group\n  name: group-plugin\n  group: true\n  config:\n    - id: nested\n      name: nested-plugin\n`;
    const nestedTarget = '- id: nested\n  disabled: true\n';
    const nested = preparePatchExport(base, nestedTarget);
    expect(nested.value).toEqual({ exportMode: 'opaque-profile-patch', patch: nestedTarget });
    expect(nested.diagnostics.map(({ code }) => code)).toEqual([
      'W_PATCH_EXTERNAL_BASELINE',
      'W_PATCH_OPAQUE',
    ]);

    const insertedThenTargeted = `- insert:\n    - id: own-row\n      name: own-plugin\n- id: own-row\n  disabled: true\n`;
    const portable = preparePatchExport('[]\n', insertedThenTargeted);
    expect(portable).toEqual({
      ok: true,
      value: {
        exportMode: 'minimal-whole-row',
        patch: [{ insert: [{ id: 'own-row', name: 'own-plugin', disabled: true }] }],
      },
      diagnostics: [],
    });
  });

  it.each([
    [
      'a relevant !!js scalar',
      '- id: agent-loop\n  config:\n    model: !!js process.env.DSH_MODEL\n',
    ],
    [
      'an unsupported official group-insert form',
      '- id: a-group\n  insert:\n    - id: nested\n      name: nested-plugin\n',
    ],
    [
      'an open-field override outside the emitter subset',
      '- id: timer\n  intercept:\n    logger: isolated\n',
    ],
    [
      'a skipped name-guard form',
      '- id: timer\n  name: not-the-baseline-plugin\n  disabled: true\n',
    ],
  ])('keeps %s byte-for-byte as an opaque profile patch', async (_name, profilePatch) => {
    const result = preparePatchExport(await fixture('e9/dump-default-config.yml'), profilePatch);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      exportMode: 'opaque-profile-patch',
      patch: profilePatch,
    });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'W_PATCH_OPAQUE', severity: 'warning' }),
    ]);
  });

  it('keeps a plain scalar override opaque when it touches a tagged baseline config', () => {
    const baseline = `- id: a
  config:
    value: !!js process.env.X
`;
    const profilePatch = `- id: a
  config:
    value: process.env.X
`;

    const result = preparePatchExport(baseline, profilePatch);

    expect(result).toEqual({
      ok: true,
      value: { exportMode: 'opaque-profile-patch', patch: profilePatch },
      diagnostics: [expect.objectContaining({ code: 'W_PATCH_OPAQUE', severity: 'warning' })],
    });
  });

  it('keeps a plain scalar override opaque when it touches tagged baseline disabled metadata', () => {
    const baseline = `- id: a
  disabled: !!js process.env.DISABLED
`;
    const profilePatch = `- id: a
  disabled: process.env.DISABLED
`;

    const result = preparePatchExport(baseline, profilePatch);

    expect(result).toEqual({
      ok: true,
      value: { exportMode: 'opaque-profile-patch', patch: profilePatch },
      diagnostics: [expect.objectContaining({ code: 'W_PATCH_OPAQUE', severity: 'warning' })],
    });
  });

  it('falls back to the original profile bytes when the default dump cannot be parsed', () => {
    const profilePatch = '[]\n';
    const result = preparePatchExport('invalid: [unclosed\n', profilePatch);

    expect(result).toEqual({
      ok: true,
      value: { exportMode: 'opaque-profile-patch', patch: profilePatch },
      diagnostics: [expect.objectContaining({ code: 'W_PATCH_OPAQUE', severity: 'warning' })],
    });
  });
});
