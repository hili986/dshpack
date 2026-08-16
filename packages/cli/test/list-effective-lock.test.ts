import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PackLock } from '@dshpack/core';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectMetadata } from '../src/list/contracts.js';
import {
  type SecurityMarker,
  SHA256_B,
  SHA512,
  securityHome,
  securityMarker,
} from './list-switch-security-fixture.js';

const homes: string[] = [];

const SHA512_B = `sha512-${'B'.repeat(86)}==`;

function plugin(name = '@example/demo-plugin', version = '1.2.3') {
  return {
    name,
    packageJsonSha512: SHA512,
    bundlePatch: 'cordis.patch.yml',
    actualResolved: { version },
    actualIntegrity: { kind: 'npm-sri', value: SHA512 },
  } as const;
}

function effectiveLock(marker: SecurityMarker): PackLock {
  const installed = marker.plugins as ReturnType<typeof plugin>[];
  return {
    lockVersion: 0,
    manifestSha256: marker.pack.manifestDigest,
    generatedBy: 'dshpack@0.0.0',
    generatedAt: '2026-08-16T00:00:00.000Z',
    dsh: { exportedFrom: '0.1.0-rc.6' },
    plugins: installed.map((entry) => ({
      name: entry.name,
      resolved: entry.actualResolved,
      integrity: entry.actualIntegrity,
      packageJsonSha512: entry.packageJsonSha512,
      bundlePatch: entry.bundlePatch,
    })),
    files: [{ path: 'patch/cordis.patch.yml', sha512: SHA512 }],
  };
}

function mutateFirst(lock: PackLock, mutation: Partial<PackLock['plugins'][number]>): PackLock {
  const [first, ...rest] = lock.plugins;
  if (first === undefined) throw new Error('test fixture requires at least one locked plugin');
  return { ...lock, plugins: [{ ...first, ...mutation }, ...rest] };
}

async function writeMetadata(home: string, value: unknown): Promise<void> {
  const directory = join(home, '.dshpack', 'installed');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'demo.json'), JSON.stringify(value), 'utf8');
}

async function setup() {
  const home = await securityHome('list-effective-lock');
  homes.push(home);
  const marker = {
    ...securityMarker(home),
    plugins: [plugin(), plugin('@example/second-plugin', '2.3.4')],
  };
  return { home, marker, lock: effectiveLock(marker) };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('InstalledMetadataV0 effective lock', () => {
  it('requires and accepts a complete PackLock', async () => {
    const { home, marker, lock } = await setup();
    await writeMetadata(home, { ...marker, effectiveLock: lock });
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({ status: 'valid' });

    await writeMetadata(home, marker);
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({ status: 'broken' });

    const { generatedBy: _generatedBy, ...missingRequiredLockField } = lock;
    await writeMetadata(home, { ...marker, effectiveLock: missingRequiredLockField });
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({ status: 'broken' });
  });

  it.each([
    [
      'missing lockVersion',
      (lock: PackLock) => {
        const { lockVersion: _lockVersion, ...withoutLockVersion } = lock;
        return withoutLockVersion;
      },
    ],
    ['wrong lockVersion literal', (lock: PackLock) => ({ ...lock, lockVersion: 1 })],
    ['top-level additional property', (lock: PackLock) => ({ ...lock, unexpected: true })],
    [
      'nested additional property',
      (lock: PackLock) => ({ ...lock, dsh: { ...lock.dsh, unexpected: true } }),
    ],
    [
      'plugin additional property',
      (lock: PackLock) => ({
        ...lock,
        plugins: lock.plugins.map((entry, index) =>
          index === 0 ? { ...entry, unexpected: true } : entry,
        ),
      }),
    ],
    [
      'file additional property',
      (lock: PackLock) => ({
        ...lock,
        files: lock.files.map((entry, index) =>
          index === 0 ? { ...entry, unexpected: true } : entry,
        ),
      }),
    ],
    [
      'invalid file sha512',
      (lock: PackLock) => ({
        ...lock,
        files: lock.files.map((entry, index) =>
          index === 0 ? { ...entry, sha512: 'md5-not-a-sha512' } : entry,
        ),
      }),
    ],
  ])('rejects core PackLock shape violation: %s', async (_label, mutate) => {
    const { home, marker, lock } = await setup();
    await writeMetadata(home, { ...marker, effectiveLock: mutate(lock) });
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({ status: 'broken' });
  });

  it.each([
    ['manifest digest', (lock: PackLock) => ({ ...lock, manifestSha256: SHA256_B })],
    ['plugin count', (lock: PackLock) => ({ ...lock, plugins: lock.plugins.slice(0, 1) })],
    ['plugin order', (lock: PackLock) => ({ ...lock, plugins: [...lock.plugins].reverse() })],
    ['plugin name', (lock: PackLock) => mutateFirst(lock, { name: '@example/other-plugin' })],
    ['plugin resolved', (lock: PackLock) => mutateFirst(lock, { resolved: { version: '9.9.9' } })],
    [
      'plugin integrity',
      (lock: PackLock) => mutateFirst(lock, { integrity: { kind: 'npm-sri', value: SHA512_B } }),
    ],
    [
      'plugin package digest',
      (lock: PackLock) => mutateFirst(lock, { packageJsonSha512: SHA512_B }),
    ],
    ['plugin bundle patch', (lock: PackLock) => mutateFirst(lock, { bundlePatch: 'other.yml' })],
  ])('rejects an effectiveLock with mismatched %s', async (_label, mutate) => {
    const { home, marker, lock } = await setup();
    await writeMetadata(home, { ...marker, effectiveLock: mutate(lock) });
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({ status: 'broken' });
  });

  it.each([
    ['unsafe', [{ path: '../escape', sha512: SHA512 }]],
    [
      'duplicate',
      [
        { path: 'patch/demo.yml', sha512: SHA512 },
        { path: 'patch/demo.yml', sha512: SHA512 },
      ],
    ],
    [
      'case-folded duplicate',
      [
        { path: 'patch/DEMO.yml', sha512: SHA512 },
        { path: 'patch/demo.yml', sha512: SHA512 },
      ],
    ],
    ['manifest self-reference', [{ path: 'pack.yml', sha512: SHA512 }]],
    ['self-referential', [{ path: 'pack.lock.yml', sha512: SHA512 }]],
    ['case-folded self-referential', [{ path: 'PACK.LOCK.YML', sha512: SHA512 }]],
  ])('rejects %s effectiveLock files', async (_label, files) => {
    const { home, marker, lock } = await setup();
    await writeMetadata(home, { ...marker, effectiveLock: { ...lock, files } });
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({ status: 'broken' });
  });

  it.each([
    [
      'generatedBy package identity',
      (lock: PackLock) => ({ ...lock, generatedBy: 'another-tool@1.0.0' }),
    ],
    ['generatedBy semver', (lock: PackLock) => ({ ...lock, generatedBy: 'dshpack@1.0.0-01' })],
    ['generatedAt shape', (lock: PackLock) => ({ ...lock, generatedAt: '2026-08-16Tbad' })],
    ['generatedAt', (lock: PackLock) => ({ ...lock, generatedAt: '2026-99-99T00:00:00Z' })],
    ['dsh exportedFrom', (lock: PackLock) => ({ ...lock, dsh: { exportedFrom: '1.0.0-01' } })],
  ])('rejects invalid effectiveLock %s semantics beyond the core shape', async (_label, mutate) => {
    const { home, marker, lock } = await setup();
    await writeMetadata(home, { ...marker, effectiveLock: mutate(lock) });
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({ status: 'broken' });
  });

  it('binds effectiveLock.generatedAt to metadata.installedAt', async () => {
    const { home, marker, lock } = await setup();
    await writeMetadata(home, {
      ...marker,
      effectiveLock: { ...lock, generatedAt: '2026-08-16T00:00:01.000Z' },
    });
    await expect(inspectMetadata(home, 'demo')).resolves.toMatchObject({ status: 'broken' });
  });
});
