import { describe, expect, it } from 'vitest';

import { parseCanonicalYaml, parseLock, parsePack } from '../src/index.js';

const minimalPack = `formatVersion: 0
name: web-dev
version: 0.1.0
description: 最小合法包
author: dsh-packs
license: MIT
dsh:
  tested: [0.1.0-rc.6]
plugins: []
mcp: []
defaults:
  permissionPreset: workspace-write
`;

describe('canonical YAML', () => {
  it('accepts UTF-8 text with LF and preserves parsed comments in the Document', () => {
    const result = parseCanonicalYaml(`# comment\n${minimalPack}`);
    expect(result.ok).toBe(true);
    expect(result.value?.document.toString()).toContain('# comment');
  });

  it.each([
    ['CRLF', minimalPack.replaceAll('\n', '\r\n'), 'E_YAML_LINE_ENDING'],
    ['duplicate key', `${minimalPack}name: duplicate\n`, 'E_YAML_DUPLICATE_KEY'],
    ['multiple document', `${minimalPack}---\nname: second\n`, 'E_YAML_MULTIPLE_DOCUMENTS'],
    ['alias', `${minimalPack}copy: &copy value\nother: *copy\n`, 'E_YAML_ALIAS'],
    ['unknown tag', `${minimalPack}x: !unknown value\n`, 'E_YAML_TAG'],
    ['js tag without exception', `${minimalPack}x: !!js process.env.X\n`, 'E_YAML_TAG'],
  ])('rejects %s', (_name, source, code) => {
    expect(parseCanonicalYaml(source).diagnostics).toEqual([expect.objectContaining({ code })]);
  });

  it('leaves a narrow !!js exception switch for W7 without evaluating it', () => {
    const result = parseCanonicalYaml(`${minimalPack}x: !!js process.env.X\n`, {
      allowJsTag: true,
    });
    expect(result.ok).toBe(true);
    expect(result.value?.value).toMatchObject({ x: 'process.env.X' });
  });
});

describe('pack readers', () => {
  it('parses and validates a canonical pack', () => {
    const result = parsePack(minimalPack);
    expect(result.ok).toBe(true);
    expect(result.value?.name).toBe('web-dev');
  });

  it('rejects a non-lock mapping through the lock reader', () => {
    const result = parseLock(minimalPack);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.message).not.toBe('校验失败');
  });
});
