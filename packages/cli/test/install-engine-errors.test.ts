import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { installPack } from '../src/install/engine.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-engine-errors-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('install engine typed stage failures', () => {
  it('rejects an invalid existing settings document inside the transaction', async () => {
    const dshHome = await home();
    await writeFile(join(dshHome, 'settings.yaml'), '- invalid-root\n');
    const report = await installPack(
      {
        source: await enginePack({ assets: true }),
        dshHome,
        yes: true,
        interactive: false,
      },
      fakeRuntime().runtime,
    );
    expect(report).toMatchObject({ exitCode: 30, metadata: { status: 'rolled-back' } });
    expect(report.diagnostics).toContainEqual(expect.objectContaining({ code: 'E_SETTINGS_ROOT' }));
  });

  it.each([
    ['authorize workspace', 30],
    ['rebuild subprocess', 23],
    ['asset payload write', 30],
    ['profile patch write', 30],
    ['doctor throw', 24],
    ['locked state capture', 31],
  ] as const)('maps %s to the minimal exit instead of internal 70', async (scenario, exitCode) => {
    const dshHome = await home();
    const fake = fakeRuntime(
      scenario === 'rebuild subprocess' ? { transitive: ['transitive-build'] } : {},
    );
    let source = await enginePack();
    const input = { source, dshHome, yes: true, interactive: false, allowBuilds: [] as string[] };
    if (scenario === 'authorize workspace') {
      source = await enginePack({ plugin: { allowBuilds: true } });
      input.source = source;
      input.allowBuilds = ['example-bundle'];
      fake.runtime.authorizeBuild = async () => {
        throw new Error('injected authorize');
      };
    } else if (scenario === 'rebuild subprocess') {
      input.allowBuilds = ['transitive-build'];
      fake.runtime.runPnpm = async () => {
        throw new Error('injected rebuild');
      };
    } else if (scenario === 'asset payload write') {
      input.source = await enginePack({ assets: true });
      fake.runtime.writeMaterialAsset = async () => {
        throw new Error('injected asset write');
      };
    } else if (scenario === 'profile patch write') {
      fake.runtime.atomicWriteText = async () => {
        throw new Error('injected patch write');
      };
    } else if (scenario === 'doctor throw') {
      fake.runtime.runDoctor = async () => {
        throw new Error('injected doctor');
      };
    } else {
      const capture = fake.runtime.captureTargetState;
      let calls = 0;
      fake.runtime.captureTargetState = async (request) => {
        calls += 1;
        if (calls === 3) throw new Error('injected locked capture');
        return capture(request);
      };
    }

    const report = await installPack(input, fake.runtime);
    expect(report.exitCode).toBe(exitCode);
    expect(report.exitCode).not.toBe(70);
    expect(report.metadata.status).toBe('rolled-back');
  });
});
