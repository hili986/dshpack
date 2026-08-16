import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackLockedPlugin, PluginDeclaration } from '@dshpack/core';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyInstalledPlugin } from '../src/install/profile-plugin.js';

const roots: string[] = [];
const commit = 'b07eac099753833b29d06c614149904445739776';
const npmIntegrity =
  'sha512-4LCcse/U2MHZ63HAJVE+v71o7yOdIe4cZ70Wpf8D/IyjDKYQLV5GD46B+hSTjJsvV5PztjvHoU580EftxjDZFQ==';
const gitTarIntegrity =
  'sha512-uigHjrktsOSW1YnPUBWg26mtPQ3EmZ9jcsKlIzy4ziYP6KZzQSDZqccWVrNzcuHcrvWh8LqCSs009/hBKvxO8Q==';

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-profile-lock-'));
  roots.push(root);
  return root;
}

function fixture(...segments: string[]): Promise<string> {
  return readFile(join(process.cwd(), 'packages', 'core', 'test', 'fixtures', ...segments), 'utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installed(
  root: string,
  declaration: PluginDeclaration,
  lockSource: string,
  expected: Omit<PackLockedPlugin, 'packageJsonSha512' | 'bundlePatch' | 'name'>,
): Promise<PackLockedPlugin> {
  const packageRoot = join(root, 'node_modules', 'yocto-queue');
  await mkdir(packageRoot, { recursive: true });
  const packageBytes = Buffer.from(
    `${JSON.stringify({
      name: 'yocto-queue',
      version: '1.2.2',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })}\n`,
  );
  await writeFile(join(packageRoot, 'package.json'), packageBytes);
  await writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      dependencies: { 'yocto-queue': 'locked' },
      dsh: { profile: { bundles: ['yocto-queue'] } },
    }),
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), lockSource);
  return {
    name: declaration.name,
    ...expected,
    packageJsonSha512: sri(packageBytes),
    bundlePatch: './cordis.patch.yml',
  };
}

describe('E3 real pnpm lock shapes', () => {
  it.each([
    {
      fixtureName: 'e3-npm',
      declaration: {
        name: 'yocto-queue',
        source: { kind: 'npm', range: '^1.2.0' },
        allowBuilds: false,
      } satisfies PluginDeclaration,
      expected: {
        resolved: { version: '1.2.2' },
        integrity: { kind: 'npm-sri', value: npmIntegrity },
      } satisfies Omit<PackLockedPlugin, 'packageJsonSha512' | 'bundlePatch' | 'name'>,
    },
    {
      fixtureName: 'e3-git',
      declaration: {
        name: 'yocto-queue',
        source: { kind: 'github', owner: 'sindresorhus', repo: 'yocto-queue', ref: commit },
        allowBuilds: false,
      } satisfies PluginDeclaration,
      expected: {
        resolved: { commit },
        integrity: { kind: 'git-commit', value: commit },
      } satisfies Omit<PackLockedPlugin, 'packageJsonSha512' | 'bundlePatch' | 'name'>,
    },
    {
      fixtureName: 'e3-tarball',
      declaration: {
        name: 'yocto-queue',
        source: {
          kind: 'tarball',
          url: `https://github.com/sindresorhus/yocto-queue/archive/${commit}.tar.gz`,
        },
        allowBuilds: false,
      } satisfies PluginDeclaration,
      expected: {
        resolved: {
          url: `https://github.com/sindresorhus/yocto-queue/archive/${commit}.tar.gz`,
        },
        integrity: { kind: 'sha512', value: gitTarIntegrity },
      } satisfies Omit<PackLockedPlugin, 'packageJsonSha512' | 'bundlePatch' | 'name'>,
    },
  ])('verifies the complete $fixtureName shape', async ({ fixtureName, declaration, expected }) => {
    const root = await temporary();
    const lockSource = await fixture('real-dsh', fixtureName, 'pnpm-lock.yaml');
    const locked = await installed(root, declaration, lockSource, expected);

    const fact = await verifyInstalledPlugin(root, declaration, locked);
    expect(fact.name).toBe(declaration.name);
    expect(fact.actualResolved).toEqual(expected.resolved);
    expect(fact.actualIntegrity).toEqual(expected.integrity);
    if (fixtureName === 'e3-git') {
      expect(lockSource).not.toContain('resolution.commit');
      expect(lockSource).not.toMatch(/^\s+commit:/mu);
    }
  });

  it('rejects normalized registry .tgz masquerading as an npm source with the minimal lock reason', async () => {
    const root = await temporary();
    const declaration: PluginDeclaration = {
      name: 'yocto-queue',
      source: { kind: 'npm', range: '^1.2.0' },
      allowBuilds: false,
    };
    const lockSource = await fixture('mutants', 'e3-normalized-tgz', 'pnpm-lock.yaml');
    const locked = await installed(root, declaration, lockSource, {
      resolved: { version: '1.2.2' },
      integrity: { kind: 'npm-sri', value: npmIntegrity },
    });

    await expect(verifyInstalledPlugin(root, declaration, locked)).rejects.toMatchObject({
      code: 'E_PLUGIN_LOCK',
      reasonCode: 'E_LOCK_SOURCE_MISMATCH',
    });
  });
});

describe('E3 four-location reconciliation mutants', () => {
  it.each([
    {
      location: 'importer specifier',
      mutate: (source: string) =>
        source.replace(
          'specifier: 1.2.2',
          'specifier: https://registry.npmjs.org/yocto-queue/-/yocto-queue-1.2.2.tgz',
        ),
      code: 'E_LOCK_SOURCE_MISMATCH',
    },
    {
      location: 'importer version',
      mutate: (source: string) => source.replace('version: 1.2.2', 'version: 9.9.9'),
      code: 'E_LOCK_PACKAGE_MISSING',
    },
    {
      location: 'package key',
      mutate: (source: string) => source.replace('yocto-queue@1.2.2:', 'yocto-queue@9.9.9:'),
      code: 'E_LOCK_PACKAGE_MISSING',
    },
    {
      location: 'resolution integrity',
      mutate: (source: string) => source.replace(npmIntegrity, 'sha512-AA=='),
      code: 'E_PLUGIN_LOCK_MISMATCH',
    },
  ])('turns RED when $location is mutated', async ({ mutate, code }) => {
    const root = await temporary();
    const declaration: PluginDeclaration = {
      name: 'yocto-queue',
      source: { kind: 'npm', range: '^1.2.0' },
      allowBuilds: false,
    };
    const original = await fixture('real-dsh', 'e3-npm', 'pnpm-lock.yaml');
    const locked = await installed(root, declaration, mutate(original), {
      resolved: { version: '1.2.2' },
      integrity: { kind: 'npm-sri', value: npmIntegrity },
    });

    const rejection = expect(verifyInstalledPlugin(root, declaration, locked)).rejects;
    if (code === 'E_PLUGIN_LOCK_MISMATCH') await rejection.toMatchObject({ code });
    else await rejection.toMatchObject({ code: 'E_PLUGIN_LOCK', reasonCode: code });
  });
});
