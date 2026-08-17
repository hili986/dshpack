import { readFileSync } from 'node:fs';

/**
 * The manifest sits one level above both `src/` and `dist/`, so this same relative
 * lookup resolves when running from source, from the build output, and from an
 * installed copy under `node_modules/dshpack/`. Node already parsed this exact file
 * to learn the package is ESM, so reaching this module means it is readable.
 */
const MANIFEST = new URL('../package.json', import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVersion(manifestText: string): string {
  const manifest: unknown = JSON.parse(manifestText);
  const version = isRecord(manifest) ? manifest.version : undefined;
  if (typeof version !== 'string' || version.length === 0)
    throw new Error('dshpack package.json declares no version');
  return version;
}

/** The one place the running tool learns its own version. */
export const DSHPACK_VERSION = parseVersion(readFileSync(MANIFEST, 'utf8'));

/**
 * Stamped into every artifact dshpack generates — pack locks, export locks, and the
 * effective lock recorded on install. Deriving it here keeps the audit trail honest:
 * a copy per call site is a copy that goes stale, and one already had.
 */
export const GENERATED_BY = `dshpack@${DSHPACK_VERSION}`;
