import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import { prepareAgentPresetsMerge } from '../src/adapters/settings.js';

const settingsPath = 'sandbox/settings.yaml';
const fragmentPath = 'pack/settings/agent-presets.yml';

describe('prepareAgentPresetsMerge', () => {
  it('returns a comment-preserving new document without mutating either source', () => {
    const current = [
      '# document comment',
      'agent-presets:',
      '  stable: # stable comment',
      '    model: keep # model comment',
      '  obsolete: remove',
      'other:',
      '  untouched: true # other comment',
      '',
    ].join('\n');
    const fragment = 'stable:\n  model: keep\n  added: true\nselected: demo\n';

    const result = prepareAgentPresetsMerge({
      currentDocument: current,
      fragment,
      settingsPath,
      fragmentPath,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value === undefined) throw new Error('prepare failed');
    expect(result.value.section).toEqual({
      stable: { model: 'keep', added: true },
      selected: 'demo',
    });
    expect(result.value.document).toContain('# document comment');
    expect(result.value.document).toContain('# stable comment');
    expect(result.value.document).toContain('# model comment');
    expect(result.value.document).toContain('# other comment');
    expect(result.value.document).not.toContain('obsolete:');
    expect(current).toContain('obsolete: remove');
    expect(fragment).toBe('stable:\n  model: keep\n  added: true\nselected: demo\n');
  });

  it.each([
    ['sequence root', '- demo\n', 'E_SETTINGS_FRAGMENT_ROOT'],
    ['namespace wrapper', 'agent-presets:\n  selected: demo\n', 'E_SETTINGS_FRAGMENT_NAMESPACE'],
    ['alias', 'base: &base demo\nselected: *base\n', 'E_SETTINGS_FRAGMENT_ALIAS'],
    ['anchor', 'selected: &selected demo\n', 'E_SETTINGS_FRAGMENT_ALIAS'],
    ['secret', 'apiKey: sk-TESTONLY-00000000000000000000000000000000\n', 'E_SECRET_KEY'],
  ])('rejects an unsafe %s leaf fragment', (_name, fragment, code) => {
    const result = prepareAgentPresetsMerge({
      currentDocument: 'other: true\n',
      fragment,
      settingsPath,
      fragmentPath,
    });
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (item) => item.code === code && item.path?.startsWith(fragmentPath) === true,
      ),
    ).toBe(true);
  });

  it('fails closed on aliases at the existing namespace boundary', () => {
    const result = prepareAgentPresetsMerge({
      currentDocument: 'shared: &shared\n  selected: old\nagent-presets: *shared\n',
      fragment: 'selected: new\n',
      settingsPath,
      fragmentPath,
    });
    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_ALIAS', path: settingsPath })],
    });
  });

  it('keeps aliases wholly owned by untouched namespaces', () => {
    const result = prepareAgentPresetsMerge({
      currentDocument: 'shared: &shared\n  enabled: true\nother: *shared\n',
      fragment: 'selected: demo\n',
      settingsPath,
      fragmentPath,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === undefined) throw new Error('prepare failed');
    expect(parseDocument(result.value.document).toJS()).toEqual({
      shared: { enabled: true },
      other: { enabled: true },
      'agent-presets': { selected: 'demo' },
    });
    expect(result.value.document).toContain('&shared');
    expect(result.value.document).toContain('*shared');
  });

  it('returns sanitized diagnostics for invalid YAML on either side', () => {
    const invalidCurrent = prepareAgentPresetsMerge({
      currentDocument: 'agent-presets: [private-current\n',
      fragment: 'selected: demo\n',
      settingsPath,
      fragmentPath,
    });
    expect(invalidCurrent).toEqual({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: 'E_SETTINGS_INVALID_YAML', path: settingsPath }),
      ],
    });
    expect(JSON.stringify(invalidCurrent)).not.toContain('private-current');

    const invalidFragment = prepareAgentPresetsMerge({
      currentDocument: '',
      fragment: 'selected: [private-fragment\n',
      settingsPath,
      fragmentPath,
    });
    expect(invalidFragment).toEqual({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: 'E_SETTINGS_FRAGMENT_INVALID_YAML', path: fragmentPath }),
      ],
    });
    expect(JSON.stringify(invalidFragment)).not.toContain('private-fragment');
  });
});
