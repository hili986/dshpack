import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { confirm, isCancel } from '@clack/prompts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { materializeSource } from '../src/adapters/source.js';
import { runDoctor } from '../src/doctor/engine.js';
import { stagePluginTarballDownload } from '../src/install/plugin-download.js';
import { auditInstalledBuildScripts } from '../src/install/profile-builds.js';
import { validateOfficialProfileInit } from '../src/install/profile-init.js';
import { verifyInstalledPlugin } from '../src/install/profile-plugin.js';
import { readValidatedPack } from '../src/install/read.js';
import { createNodeInstallRuntime } from '../src/install/runtime.js';
import {
  authorizeWorkspaceBuild,
  writeMaterialAssetSnapshot,
} from '../src/install/runtime-assets.js';
import { createPathProcessRuntime } from '../src/install/runtime-process.js';
import { captureInstallTargetState } from '../src/install/runtime-state.js';
import { createNodeTransactionAdapter } from '../src/transaction-node-adapter.js';

const state = vi.hoisted(() => ({
  process: {
    probe: vi.fn(async () => ({ dshVersion: '0.1.0-rc.6', pnpmVersion: '10.0.0' })),
    runDsh: vi.fn(async () => ({ stdout: 'dsh', stderr: '' })),
    runPnpm: vi.fn(async () => ({ stdout: 'pnpm', stderr: '' })),
  },
}));

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return {
    ...actual,
    confirm: vi.fn(async () => true),
    isCancel: vi.fn(() => false),
  };
});
vi.mock('../src/adapters/source.js', () => ({ materializeSource: vi.fn() }));
vi.mock('../src/doctor/engine.js', () => ({ runDoctor: vi.fn() }));
vi.mock('../src/install/profile-builds.js', () => ({ auditInstalledBuildScripts: vi.fn() }));
vi.mock('../src/install/profile-init.js', () => ({ validateOfficialProfileInit: vi.fn() }));
vi.mock('../src/install/profile-plugin.js', () => ({ verifyInstalledPlugin: vi.fn() }));
vi.mock('../src/install/plugin-download.js', () => ({ stagePluginTarballDownload: vi.fn() }));
vi.mock('../src/install/read.js', () => ({ readValidatedPack: vi.fn() }));
vi.mock('../src/install/runtime-assets.js', () => ({
  authorizeWorkspaceBuild: vi.fn(),
  writeMaterialAssetSnapshot: vi.fn(),
}));
vi.mock('../src/install/runtime-process.js', () => ({
  createPathProcessRuntime: vi.fn(() => state.process),
}));
vi.mock('../src/install/runtime-state.js', () => ({ captureInstallTargetState: vi.fn() }));
vi.mock('../src/transaction-node-adapter.js', () => ({
  createNodeTransactionAdapter: vi.fn(() => ({ marker: 'transaction' })),
}));

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-runtime-composition-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('production install runtime composition', () => {
  it('binds every operation to the injected PATH process and immutable helpers', async () => {
    const home = await temporary();
    const stderr = vi.fn();
    const prompt = vi.fn(async () => true);
    const runtime = createNodeInstallRuntime(home, {
      confirm: prompt,
      env: { PATH: 'C:/test-bin' },
      network: { hostnamePolicy: async () => true },
      now: () => '2026-08-16T00:00:00.000Z',
      process: state.process,
      txid: () => 'tx-fixture',
      writeStderr: stderr,
    });
    expect(runtime.transactionAdapter).toEqual({ marker: 'transaction' });
    expect(createNodeTransactionAdapter).toHaveBeenCalledOnce();

    await runtime.materializeSource('fixture');
    await runtime.readValidatedPack('snapshot');
    await runtime.probe();
    await runtime.captureTargetState({ dshHome: home, profile: 'demo', skills: [], presets: [] });
    expect(materializeSource).toHaveBeenCalledWith('fixture');
    expect(readValidatedPack).toHaveBeenCalledWith('snapshot', { frozen: false });
    expect(captureInstallTargetState).toHaveBeenCalledOnce();

    const textPath = join(home, 'fact.txt');
    await writeFile(textPath, 'fact');
    expect(await runtime.pathExists(textPath)).toBe(true);
    expect(await runtime.pathExists(join(home, 'missing'))).toBe(false);
    await expect(runtime.pathExists('\u0000')).rejects.toThrow();
    expect(await runtime.readText(textPath)).toBe('fact');
    expect(await runtime.readTextIfExists(textPath)).toBe('fact');
    expect(await runtime.readTextIfExists(join(home, 'missing'))).toBeUndefined();
    await expect(runtime.readTextIfExists(home)).rejects.toThrow();
    const atomic = join(home, 'nested', 'atomic.txt');
    await runtime.atomicWriteText(atomic, 'atomic');
    expect(await readFile(atomic, 'utf8')).toBe('atomic');

    await runtime.writeMaterialAsset({} as never, 'source', 'target', 'skill');
    await runtime.authorizeBuild('profile', 'exact-package');
    await runtime.runDsh(['--version'], { dshHome: home });
    await runtime.runPnpm(['--version'], { dshHome: home, cwd: home });
    await runtime.confirm({ kind: 'install', subject: 'demo', defaultValue: false });
    runtime.writeStderr('review');
    await runtime.verifyOfficialProfileInit('profile', 'demo');
    await runtime.verifyInstalledPlugin('profile', {} as never, {} as never);
    await runtime.auditInstalledBuildScripts('profile', [], new Set());
    await runtime.stagePluginTarball({} as never, {} as never, home);
    expect(writeMaterialAssetSnapshot).toHaveBeenCalledOnce();
    expect(authorizeWorkspaceBuild).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith('review');
    expect(validateOfficialProfileInit).toHaveBeenCalledOnce();
    expect(verifyInstalledPlugin).toHaveBeenCalledOnce();
    expect(auditInstalledBuildScripts).toHaveBeenCalledOnce();
    expect(stagePluginTarballDownload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      home,
      expect.objectContaining({ hostnamePolicy: expect.any(Function) }),
    );

    vi.mocked(runDoctor).mockImplementation(async (input, dependencies) => {
      await dependencies?.runDsh?.(['--version'], {
        dshHome: input.dshHome,
        cwd: home,
        timeout: 5_000,
      });
      return { diagnostics: [], exitCode: 0, metadata: { checks: [] } } as never;
    });
    await runtime.runDoctor({ dshHome: home, profile: 'demo' });
    expect(runDoctor).toHaveBeenCalledWith(
      expect.objectContaining({ dshHome: home, env: { PATH: 'C:/test-bin' } }),
      expect.objectContaining({ runDsh: expect.any(Function) }),
    );
    expect(state.process.runDsh).toHaveBeenCalledWith(['--version'], {
      dshHome: home,
      cwd: home,
    });
    await runtime.fault('metadata');
    expect(runtime.now()).toBe('2026-08-16T00:00:00.000Z');
    expect(runtime.txid()).toBe('tx-fixture');
  });

  it('uses fail-closed defaults for prompt, output, clock, txid, env, and process', async () => {
    const home = await temporary();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const runtime = createNodeInstallRuntime(home);
    expect(createPathProcessRuntime).toHaveBeenCalledWith({});
    expect(await runtime.confirm({ kind: 'install', subject: 'demo', defaultValue: false })).toBe(
      true,
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: false, output: process.stderr }),
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    vi.mocked(confirm).mockResolvedValueOnce(Symbol('cancel'));
    expect(await runtime.confirm({ kind: 'install', subject: 'demo', defaultValue: false })).toBe(
      false,
    );
    runtime.writeStderr('default output');
    expect(write).toHaveBeenCalledWith('default output\n');
    expect(runtime.now()).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(runtime.txid()).toMatch(/^tx-[0-9a-f-]{36}$/u);

    vi.mocked(runDoctor).mockResolvedValue({ diagnostics: [], exitCode: 0, metadata: {} } as never);
    await runtime.runDoctor({ dshHome: home });
    expect(runDoctor).toHaveBeenCalledWith(
      expect.not.objectContaining({ env: expect.anything() }),
      expect.anything(),
    );
    await runtime.stagePluginTarball({} as never, {} as never, home);
    expect(stagePluginTarballDownload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      home,
      undefined,
    );
  });
});
