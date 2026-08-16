import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SourceError } from '../src/adapters/source.js';
import { installPack } from '../src/install/engine.js';
import type { InstallRuntime } from '../src/install/runtime-types.js';
import { enginePack, fakeRuntime, snapshot } from './install-engine-fixture.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-default-resolution-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function installResolution() {
  const integrity = `sha512-${createHash('sha512').update('resolved-tarball').digest('base64')}`;
  return {
    mode: 'manifest' as const,
    resolutionDigest: `sha256-${createHash('sha256').update(integrity).digest('base64url')}`,
    plugins: [
      {
        name: 'example-bundle',
        resolved: { version: '1.2.3' },
        integrity: { kind: 'npm-sri' as const, value: integrity },
      },
    ],
  };
}

function withResolver(runtime: InstallRuntime, calls: string[]): InstallRuntime {
  const extended = runtime as InstallRuntime & {
    resolvePlugins(): Promise<ReturnType<typeof installResolution>>;
  };
  extended.resolvePlugins = async () => {
    calls.push('resolve:manifest');
    return installResolution();
  };
  return extended;
}

describe('install manifest resolution mode', () => {
  it('plans an exact verified plugin without pack.lock by default and writes no source or target bytes', async () => {
    const source = await enginePack({ plugin: {} });
    await rm(join(source, 'pack.lock.yml'));
    const dshHome = await home();
    const sourceBefore = await snapshot(source);
    const targetBefore = await snapshot(dshHome);
    const fake = fakeRuntime();

    const report = await installPack(
      { source, dshHome, dryRun: true, json: true, interactive: false },
      withResolver(fake.runtime, fake.calls),
    );

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        status: 'planned',
        plan: {
          frozen: false,
          plugins: [
            expect.objectContaining({
              name: 'example-bundle',
              exactSpec: 'example-bundle@1.2.3',
              integrity: expect.objectContaining({ kind: 'npm-sri' }),
            }),
          ],
        },
      },
    });
    expect(report.metadata.plan?.plugins[0]).not.toHaveProperty('expectedPackageJsonSha512');
    expect(fake.calls).toContain('resolve:manifest');
    expect(await snapshot(source)).toEqual(sourceBefore);
    expect(await snapshot(dshHome)).toEqual(targetBefore);
  });

  it('requires pack.lock only when --frozen is explicit', async () => {
    const source = await enginePack({ plugin: {} });
    await rm(join(source, 'pack.lock.yml'));
    const dshHome = await home();
    const fake = fakeRuntime();

    const report = await installPack(
      { source, dshHome, frozen: true, dryRun: true, json: true, interactive: false },
      withResolver(fake.runtime, fake.calls),
    );

    expect(report).toMatchObject({
      exitCode: 20,
      metadata: { status: 'not-started' },
      diagnostics: [expect.objectContaining({ code: 'E_NO_LOCK' })],
    });
    expect(fake.calls).not.toContain('resolve:manifest');
  });

  it('ignores stale pack.lock bytes in default mode instead of consuming them', async () => {
    const source = await enginePack({ plugin: {} });
    await writeFile(join(source, 'pack.lock.yml'), 'stale: true\n');
    const sourceBefore = await snapshot(source);
    const dshHome = await home();
    const fake = fakeRuntime();

    const report = await installPack(
      { source, dshHome, dryRun: true, json: true, interactive: false },
      withResolver(fake.runtime, fake.calls),
    );

    expect(report.exitCode).toBe(0);
    expect(report.metadata.plan?.plugins[0]?.exactSpec).toBe('example-bundle@1.2.3');
    expect(report.metadata.plan?.lockDigest).not.toContain('stale');
    expect(fake.calls).toContain('resolve:manifest');
    expect(await snapshot(source)).toEqual(sourceBefore);
  });

  it('persists a new effective lock only from post-add installed facts', async () => {
    const source = await enginePack({ plugin: {} });
    await rm(join(source, 'pack.lock.yml'));
    const dshHome = await home();
    const fake = fakeRuntime();

    const report = await installPack(
      { source, dshHome, yes: true, interactive: false },
      withResolver(fake.runtime, fake.calls),
    );

    expect(report.exitCode).toBe(0);
    const metadata = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      effectiveLock: {
        lockVersion: 0,
        manifestSha256: report.metadata.plan?.manifestDigest,
        plugins: [
          {
            name: 'example-bundle',
            resolved: { version: '1.2.3' },
            integrity: expect.objectContaining({ kind: 'npm-sri' }),
            packageJsonSha512: expect.stringMatching(/^sha512-/u),
            bundlePatch: 'lib/index.yml',
          },
        ],
        files: [expect.objectContaining({ path: 'patch/cordis.patch.yml' })],
      },
    });
    const effective = metadata.effectiveLock as { files: Array<{ path: string }> };
    expect(effective.files.map(({ path }) => path)).not.toContain('pack.yml');
    expect(effective.files.map(({ path }) => path)).not.toContain('pack.lock.yml');
    expect(report.metadata.plan?.plugins[0]).not.toHaveProperty('expectedInstalledFacts');
  });

  it.each([
    ['typed', new SourceError('E_RESOLUTION_NETWORK', 20, 'blocked source', 'use local clone')],
    ['generic', new Error('resolver mutant')],
  ] as const)('classifies a %s resolver failure before any target write', async (kind, error) => {
    const fake = fakeRuntime();
    fake.runtime.resolvePlugins = async () => {
      throw error;
    };
    const report = await installPack(
      { source: await enginePack(), dshHome: await home(), yes: true, interactive: false },
      fake.runtime,
    );
    expect(report).toMatchObject({
      exitCode: 20,
      metadata: { status: 'not-started' },
      diagnostics: [
        expect.objectContaining({
          code: kind === 'typed' ? 'E_RESOLUTION_NETWORK' : 'E_PLUGIN_RESOLUTION',
        }),
      ],
    });
    expect(fake.calls).not.toContain('transaction:operation');
  });

  it('fails closed when the target cannot be recaptured after confirmation', async () => {
    const fake = fakeRuntime();
    const capture = fake.runtime.captureTargetState;
    let captures = 0;
    fake.runtime.captureTargetState = async (request) => {
      captures += 1;
      if (captures === 2) throw new Error('post-confirm capture mutant');
      return capture(request);
    };
    const report = await installPack(
      { source: await enginePack(), dshHome: await home(), yes: true, interactive: false },
      fake.runtime,
    );
    expect(report).toMatchObject({
      exitCode: 31,
      metadata: { status: 'not-started' },
      diagnostics: [expect.objectContaining({ code: 'E_TARGET_STATE' })],
    });
    expect(fake.calls).not.toContain('transaction:operation');
  });
});
