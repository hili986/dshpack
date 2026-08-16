import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isWithinRoot,
  type PackTreeEntry,
  validatePackPath,
  validatePackTree,
} from '../src/index.js';

const root = '/pack-root';

describe('POSIX pack paths', () => {
  it.each([
    ['', 'E_PATH_EMPTY'],
    ['/etc/passwd', 'E_PATH_ABSOLUTE'],
    ['C:/Windows/system32', 'E_PATH_DRIVE'],
    ['\\\\server\\share', 'E_PATH_BACKSLASH'],
    ['dir\\file.md', 'E_PATH_BACKSLASH'],
    ['a\u0000b', 'E_PATH_CONTROL'],
    ['a\u0001b', 'E_PATH_CONTROL'],
    ['.', 'E_PATH_SEGMENT'],
    ['a/../b', 'E_PATH_SEGMENT'],
    ['a//b', 'E_PATH_DOUBLE_SLASH'],
    ['a/../../etc', 'E_PATH_SEGMENT'],
  ])('rejects unsafe path %j', (path, code) => {
    expect(validatePackPath(path, root).diagnostics).toEqual([expect.objectContaining({ code })]);
  });

  it('accepts a canonical POSIX-relative path', () => {
    expect(validatePackPath('skills/web-dev/SKILL.md', root)).toEqual({
      ok: true,
      value: 'skills/web-dev/SKILL.md',
      diagnostics: [],
    });
  });

  it('requires NFC, so visually identical NFD input has one canonical representation', () => {
    expect(validatePackPath('skills/café/SKILL.md', root).ok).toBe(true);
    expect(validatePackPath('skills/cafe\u0301/SKILL.md', root).diagnostics).toEqual([
      expect.objectContaining({ code: 'E_PATH_UNICODE_NORMALIZATION' }),
    ]);
  });

  it('normalizes before proving a candidate remains in root', () => {
    expect(isWithinRoot(root, `${root}/a/../../etc`)).toBe(false);
    expect(isWithinRoot(root, `${root}/skills/web-dev/SKILL.md`)).toBe(true);
  });

  it('property: every accepted random path resolves inside root', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/), { minLength: 1, maxLength: 6 }),
        (segments) => {
          const candidate = segments.join('/');
          const result = validatePackPath(candidate, root);
          return result.ok && isWithinRoot(root, `${root}/${candidate}`);
        },
      ),
    );
  });
});

function entry(path: string, kind: PackTreeEntry['stat']['kind'], size = 0): PackTreeEntry {
  return { path, stat: { kind, size } };
}

describe('injected lstat facts and pack tree quotas', () => {
  it.each(['symlink', 'fifo', 'socket', 'block-device', 'character-device'] as const)(
    'rejects %s without importing node:fs',
    (kind) => {
      expect(validatePackTree([entry('asset', kind)]).diagnostics).toEqual([
        expect.objectContaining({ code: 'E_PATH_SPECIAL_FILE' }),
      ]);
    },
  );

  it('allows injected directories and ordinary files', () => {
    expect(
      validatePackTree([entry('skills', 'directory'), entry('skills/demo/SKILL.md', 'file', 123)]),
    ).toEqual({
      ok: true,
      value: { fileCount: 1, totalBytes: 123 },
      diagnostics: [],
    });
  });

  it('enforces single-file, aggregate, file-count, and duplicate quotas', () => {
    const oneMiB = 1024 * 1024;
    expect(validatePackTree([entry('large.bin', 'file', oneMiB + 1)]).diagnostics).toEqual([
      expect.objectContaining({ code: 'E_PATH_FILE_SIZE' }),
    ]);
    expect(
      validatePackTree([
        ...Array.from({ length: 10 }, (_, index) => entry(`ten-${index}`, 'file', oneMiB)),
        entry('extra', 'file', 1),
      ]).diagnostics,
    ).toEqual([expect.objectContaining({ code: 'E_PATH_TOTAL_SIZE' })]);
    expect(
      validatePackTree(Array.from({ length: 1001 }, (_, index) => entry(`f${index}`, 'file')))
        .diagnostics,
    ).toEqual([expect.objectContaining({ code: 'E_PATH_FILE_COUNT' })]);
    expect(validatePackTree([entry('same', 'file'), entry('same', 'file')]).diagnostics).toEqual([
      expect.objectContaining({ code: 'E_PATH_DUPLICATE' }),
    ]);
  });
});
