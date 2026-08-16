import type { Diagnostic, Result } from './contracts.js';

export const MAX_PACK_FILE_BYTES = 1024 * 1024;
export const MAX_PACK_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_PACK_FILES = 1000;

export type StatKind =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'fifo'
  | 'socket'
  | 'block-device'
  | 'character-device';

/** Filesystem facts are injected by CLI adapters; core deliberately performs no lstat itself. */
export interface StatLike {
  kind: StatKind;
  size: number;
}

export interface PackTreeEntry {
  path: string;
  stat: StatLike;
}

export interface PackTreeSummary {
  fileCount: number;
  totalBytes: number;
}

function fail<T>(code: string, message: string, hint: string, path?: string): Result<T> {
  const diagnostic: Diagnostic = {
    code,
    severity: 'error',
    message,
    ...(path === undefined ? {} : { path }),
    hint,
    evidence: 'local',
  };
  return { ok: false, diagnostics: [diagnostic] };
}

function pass<T>(value: T): Result<T> {
  return { ok: true, value, diagnostics: [] };
}

function normalizeAbsolute(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join('/')}`;
}

/**
 * Returns containment after lexical POSIX normalization. This is deliberately independent of
 * the earlier input rejection so adapters retain a defence-in-depth root escape check.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeAbsolute(root);
  const normalizedCandidate = normalizeAbsolute(candidate);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

/** Validate a pack-internal pathname without filesystem access. */
export function validatePackPath(path: string, root = '/pack-root'): Result<string> {
  if (path.length === 0)
    return fail('E_PATH_EMPTY', '路径不能为空。', '提供一个 POSIX 相对路径。', path);
  if (path.includes('\\'))
    return fail('E_PATH_BACKSLASH', '路径不能包含反斜杠。', '使用 / 作为分隔符。', path);
  if (/^[A-Za-z]:/u.test(path))
    return fail('E_PATH_DRIVE', '路径不能包含 Windows 盘符。', '使用 POSIX 相对路径。', path);
  if (path.startsWith('/'))
    return fail('E_PATH_ABSOLUTE', '路径必须是相对路径。', '移除开头的 /。', path);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are a declared pack-path rejection rule.
  if (/[\u0000-\u001F\u007F]/u.test(path))
    return fail('E_PATH_CONTROL', '路径不能包含控制字符。', '移除控制字符。', path);
  if (path.includes('//'))
    return fail('E_PATH_DOUBLE_SLASH', '路径不能包含连续的 /。', '合并连续的 /。', path);
  if (path.normalize('NFC') !== path) {
    return fail(
      'E_PATH_UNICODE_NORMALIZATION',
      '路径必须使用 NFC Unicode 规范化。',
      '将路径规范化为 NFC。',
      path,
    );
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    return fail('E_PATH_SEGMENT', '路径不能包含 . 或 .. 段。', '使用不含导航段的相对路径。', path);
  }
  if (!isWithinRoot(root, `${root}/${path}`)) {
    return fail(
      'E_PATH_ESCAPE',
      '规范化后的路径逃出了 pack 根目录。',
      '使用 pack 根目录内的相对路径。',
      path,
    );
  }
  return pass(path);
}

/** Validate adapter-supplied lstat facts and size limits for a complete pack tree. */
export function validatePackTree(entries: readonly PackTreeEntry[]): Result<PackTreeSummary> {
  const paths = new Set<string>();
  let fileCount = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    const safePath = validatePackPath(entry.path);
    if (!safePath.ok) return { ok: false, diagnostics: safePath.diagnostics };
    if (paths.has(entry.path))
      return fail('E_PATH_DUPLICATE', 'pack 中存在重复路径。', '保留一个唯一的路径。', entry.path);
    paths.add(entry.path);

    if (entry.stat.kind !== 'file' && entry.stat.kind !== 'directory') {
      return fail(
        'E_PATH_SPECIAL_FILE',
        'pack 不允许符号链接或特殊文件。',
        '仅包含普通文件和目录。',
        entry.path,
      );
    }
    if (!Number.isSafeInteger(entry.stat.size) || entry.stat.size < 0) {
      return fail(
        'E_PATH_STAT',
        '文件大小不是有效的 lstat 结果。',
        '由 adapter 提供非负整数大小。',
        entry.path,
      );
    }
    if (entry.stat.kind === 'file') {
      fileCount += 1;
      totalBytes += entry.stat.size;
      if (entry.stat.size > MAX_PACK_FILE_BYTES) {
        return fail(
          'E_PATH_FILE_SIZE',
          '单个文件超过 1 MiB 限额。',
          '缩小该文件到 1 MiB 以内。',
          entry.path,
        );
      }
    }
  }

  if (fileCount > MAX_PACK_FILES)
    return fail('E_PATH_FILE_COUNT', 'pack 文件数量超过 1000。', '减少 pack 内文件数量。');
  if (totalBytes > MAX_PACK_TOTAL_BYTES)
    return fail('E_PATH_TOTAL_SIZE', 'pack 总大小超过 10 MiB。', '减少 pack payload 总大小。');
  return pass({ fileCount, totalBytes });
}
