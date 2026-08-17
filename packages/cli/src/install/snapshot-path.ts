import { validatePackPath } from '@dshpack/core';

export type SnapshotErrorKind = 'security' | 'limit';

export class SnapshotCaptureError extends Error {
  constructor(
    readonly kind: SnapshotErrorKind,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'SnapshotCaptureError';
  }
}

export interface PortableSnapshotEntry {
  path: string;
  kind: 'file' | 'directory';
}

const windowsDevice = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

function hasC1Control(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x80 && code <= 0x9f;
  });
}

export function assertPortableSnapshotPath(path: string): void {
  const core = validatePackPath(path);
  if (!core.ok) {
    throw new SnapshotCaptureError(
      'security',
      core.diagnostics[0]?.message ?? 'unsafe pack path',
      path,
    );
  }
  for (const segment of path.split('/')) {
    if (
      segment.includes(':') ||
      /[<>"|?*]/u.test(segment) ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      windowsDevice.test(segment) ||
      hasC1Control(segment)
    ) {
      throw new SnapshotCaptureError('security', `non-portable pack path: ${path}`, path);
    }
  }
}

/** Canonical comparison key for every persisted path that must remain portable to Windows. */
export function portableSnapshotPathKey(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

export function assertPortableSnapshotEntries(entries: readonly PortableSnapshotEntry[]): void {
  const byKey = new Map<string, PortableSnapshotEntry>();
  for (const entry of entries) {
    assertPortableSnapshotPath(entry.path);
    const key = portableSnapshotPathKey(entry.path);
    if (byKey.has(key)) {
      throw new SnapshotCaptureError(
        'security',
        `portable path collision: ${entry.path}`,
        entry.path,
      );
    }
    byKey.set(key, entry);
  }
  for (const [key, entry] of byKey) {
    if (entry.kind !== 'file') continue;
    if ([...byKey.keys()].some((candidate) => candidate.startsWith(`${key}/`))) {
      throw new SnapshotCaptureError(
        'security',
        `file/directory path collision: ${entry.path}`,
        entry.path,
      );
    }
  }
}
