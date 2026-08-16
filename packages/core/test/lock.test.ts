import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type PluginDeclaration, resolveIntegrityFromPnpmLock } from '../src/index.js';

const fixtureRoot = resolve(import.meta.dirname, 'fixtures');

const npmDeclaration: PluginDeclaration = {
  name: 'yocto-queue',
  source: { kind: 'npm', range: '1.2.2' },
  allowBuilds: false,
};

const gitDeclaration: PluginDeclaration = {
  name: 'yocto-queue',
  source: {
    kind: 'github',
    owner: 'sindresorhus',
    repo: 'yocto-queue',
    ref: 'b07eac099753833b29d06c614149904445739776',
  },
  allowBuilds: false,
};

const tarballDeclaration: PluginDeclaration = {
  name: 'yocto-queue',
  source: {
    kind: 'tarball',
    url: 'https://github.com/sindresorhus/yocto-queue/archive/b07eac099753833b29d06c614149904445739776.tar.gz',
  },
  allowBuilds: false,
};

async function lock(path: string): Promise<string> {
  return readFile(resolve(fixtureRoot, path), 'utf8');
}

describe('E3 real dsh pnpm-lock.yaml fixture extraction', () => {
  it('reads packages/core/test/fixtures/real-dsh/e3-npm/pnpm-lock.yaml as exact npm + SRI facts', async () => {
    const result = resolveIntegrityFromPnpmLock(
      await lock('real-dsh/e3-npm/pnpm-lock.yaml'),
      npmDeclaration,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'yocto-queue',
        resolved: { version: '1.2.2' },
        integrity: {
          kind: 'npm-sri',
          value:
            'sha512-4LCcse/U2MHZ63HAJVE+v71o7yOdIe4cZ70Wpf8D/IyjDKYQLV5GD46B+hSTjJsvV5PztjvHoU580EftxjDZFQ==',
        },
      },
      diagnostics: [],
    });
  });

  it('reads packages/core/test/fixtures/real-dsh/e3-git/pnpm-lock.yaml and derives the 40-lowercase commit without resolution.commit', async () => {
    const result = resolveIntegrityFromPnpmLock(
      await lock('real-dsh/e3-git/pnpm-lock.yaml'),
      gitDeclaration,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'yocto-queue',
        resolved: { commit: 'b07eac099753833b29d06c614149904445739776' },
        integrity: { kind: 'git-commit', value: 'b07eac099753833b29d06c614149904445739776' },
      },
      diagnostics: [],
    });
  });

  it('reads packages/core/test/fixtures/real-dsh/e3-tarball/pnpm-lock.yaml as URL + sha512 facts', async () => {
    const result = resolveIntegrityFromPnpmLock(
      await lock('real-dsh/e3-tarball/pnpm-lock.yaml'),
      tarballDeclaration,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'yocto-queue',
        resolved: {
          url: 'https://github.com/sindresorhus/yocto-queue/archive/b07eac099753833b29d06c614149904445739776.tar.gz',
        },
        integrity: {
          kind: 'sha512',
          value:
            'sha512-uigHjrktsOSW1YnPUBWg26mtPQ3EmZ9jcsKlIzy4ziYP6KZzQSDZqccWVrNzcuHcrvWh8LqCSs009/hBKvxO8Q==',
        },
      },
      diagnostics: [],
    });
  });
});

describe('lock integrity mutants', () => {
  it('rejects a package with missing digest', async () => {
    const result = resolveIntegrityFromPnpmLock(
      await lock('mutants/e3-broken-digest/pnpm-lock.yaml'),
      npmDeclaration,
    );
    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_LOCK_DIGEST_MISSING' })],
    });
  });

  it('rejects a git branch because it is not a 40-lowercase hex pin', async () => {
    const result = resolveIntegrityFromPnpmLock(
      await lock('mutants/e3-git-unpinned/pnpm-lock.yaml'),
      gitDeclaration,
    );
    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_LOCK_GIT_UNPINNED' })],
    });
  });

  it('recognizes a normalized registry .tgz URL from importer specifier instead of trusting it as npm', async () => {
    const normalized = await lock('mutants/e3-normalized-tgz/pnpm-lock.yaml');
    expect(resolveIntegrityFromPnpmLock(normalized, tarballDeclaration)).toEqual({
      ok: true,
      value: expect.objectContaining({
        resolved: { url: 'https://registry.npmjs.org/yocto-queue/-/yocto-queue-1.2.2.tgz' },
        integrity: { kind: 'sha512', value: expect.stringMatching(/^sha512-/u) },
      }),
      diagnostics: [],
    });
    expect(resolveIntegrityFromPnpmLock(normalized, npmDeclaration)).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_LOCK_SOURCE_MISMATCH' })],
    });
  });

  it('fails closed when the lock source is missing', async () => {
    const missing = await lock('mutants/e3-missing-lock.txt');
    expect(resolveIntegrityFromPnpmLock(missing, npmDeclaration)).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_NO_LOCK' })],
    });
  });
});

function errorCode(lockYaml: string | undefined, declaration = npmDeclaration): string | undefined {
  return resolveIntegrityFromPnpmLock(lockYaml, declaration).diagnostics[0]?.code;
}

describe('lock structure failures fail closed', () => {
  it.each([
    ['parse failure', '[', 'E_LOCK_INVALID'],
    ['unsupported lock version', "lockfileVersion: '8.0'\n", 'E_LOCK_VERSION'],
    ['missing importer root', "lockfileVersion: '9.0'\nimporters: {}\n", 'E_LOCK_IMPORTER_MISSING'],
    [
      'missing dependency',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\npackages: {}\n",
      'E_LOCK_IMPORTER_MISSING',
    ],
    [
      'missing importer version',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      yocto-queue:\n        specifier: 1.2.2\npackages: {}\n",
      'E_LOCK_IMPORTER_MISSING',
    ],
    [
      'missing packages object',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      yocto-queue: {specifier: 1.2.2, version: 1.2.2}\n",
      'E_LOCK_PACKAGE_MISSING',
    ],
    [
      'missing exact package',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      yocto-queue: {specifier: 1.2.2, version: 1.2.2}\npackages: {}\n",
      'E_LOCK_PACKAGE_MISSING',
    ],
    [
      'non-object resolution',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      yocto-queue: {specifier: 1.2.2, version: 1.2.2}\npackages:\n  yocto-queue@1.2.2: {resolution: []}\n",
      'E_LOCK_DIGEST_MISSING',
    ],
    [
      'non-sha512 digest',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      yocto-queue: {specifier: 1.2.2, version: 1.2.2}\npackages:\n  yocto-queue@1.2.2: {resolution: {integrity: sha256-not-sri}}\n",
      'E_LOCK_DIGEST_MISSING',
    ],
    [
      'non-exact npm version',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      yocto-queue: {specifier: ^1.2.2, version: ^1.2.2}\npackages:\n  yocto-queue@^1.2.2: {resolution: {integrity: sha512-synthetic}}\n",
      'E_LOCK_VERSION',
    ],
  ])('rejects %s', (_name, source, code) => {
    expect(errorCode(source)).toBe(code);
  });

  it('reads a devDependency and peer-suffixed package key while still requiring all four locations', () => {
    const source = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      yocto-queue: {specifier: 1.2.2, version: 1.2.2}
packages:
  yocto-queue@1.2.2(peer@1): {resolution: {integrity: sha512-synthetic}}
`;
    expect(resolveIntegrityFromPnpmLock(source, npmDeclaration)).toMatchObject({
      ok: true,
      value: { resolved: { version: '1.2.2' } },
    });
  });

  it('rejects a tarball declaration when neither importer nor resolution carries its URL', () => {
    const source = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      yocto-queue: {specifier: 1.2.2, version: 1.2.2}
packages:
  yocto-queue@1.2.2: {resolution: {integrity: sha512-synthetic}}
`;
    expect(errorCode(source, tarballDeclaration)).toBe('E_LOCK_SOURCE_MISMATCH');
  });
});
