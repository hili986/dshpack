import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import glob from 'fast-glob';
import { describe, expect, it } from 'vitest';

import { effectiveInstallLock } from '../src/install/metadata.js';
import { DSHPACK_VERSION, GENERATED_BY, parseVersion } from '../src/version.js';

const MANIFEST = new URL('../package.json', import.meta.url);

describe('version', () => {
  it('reports the version the package itself declares', async () => {
    const declared = JSON.parse(await readFile(MANIFEST, 'utf8')) as { version: string };
    expect(DSHPACK_VERSION).toBe(declared.version);
  });

  it('stamps generated artifacts with that same version', () => {
    expect(GENERATED_BY).toBe(`dshpack@${DSHPACK_VERSION}`);
  });

  it('reads the version out of a manifest', () => {
    expect(parseVersion('{"version":"1.2.3"}')).toBe('1.2.3');
  });

  it('refuses a manifest that is not an object', () => {
    for (const text of ['null', '[]', '"1.2.3"', '3'])
      expect(() => parseVersion(text)).toThrow(/declares no version/u);
  });

  it('refuses a manifest whose version is absent, empty, or not a string', () => {
    for (const text of ['{}', '{"version":""}', '{"version":3}', '{"version":null}'])
      expect(() => parseVersion(text)).toThrow(/declares no version/u);
  });

  it('stamps the effective install lock with the running version', () => {
    const lock = effectiveInstallLock(
      { manifestDigest: `sha256-${'a'.repeat(43)}`, dsh: { current: '0.1.0-rc.6' } } as never,
      { sourceFiles: [] } as never,
      [],
      '2026-08-16T00:00:00.000Z',
    );

    expect(lock.generatedBy).toBe(GENERATED_BY);
  });

  it('leaves no producer holding its own copy of the version', async () => {
    // The install lock shipped `dshpack@0.0.0` for a whole release because three files
    // each spelled the version out and only two were ever updated.
    const sources = await glob('packages/*/src/**/*.ts', {
      absolute: true,
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    });
    expect(sources.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of sources) {
      if (file.replaceAll('\\', '/').endsWith('packages/cli/src/version.ts')) continue;
      const text = await readFile(file, 'utf8');
      if (/dshpack@\d/u.test(text)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
