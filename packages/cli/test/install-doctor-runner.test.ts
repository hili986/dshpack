import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const processState = vi.hoisted(() => ({ defaultCalls: 0 }));

vi.mock('../src/adapters/process.js', () => {
  class DshProcessError extends Error {
    readonly logPath = 'forbidden-default.log';
  }
  return {
    awaitDirectChild: async (
      child: Promise<{ exitCode: number; stdout: string; stderr?: string }>,
    ) => {
      const result = await child;
      return {
        exitCode: result.exitCode,
        failure: undefined,
        stderr: result.stderr ?? '',
        stdout: result.stdout,
        timedOut: false,
      };
    },
    DshProcessError,
    runDsh: async () => {
      processState.defaultCalls += 1;
      throw new DshProcessError('default runner must not run');
    },
  };
});

import { runDoctor } from '../src/doctor/engine.js';

const roots: string[] = [];

afterEach(async () => {
  processState.defaultCalls = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('install doctor PATH-only runner seam', () => {
  it('uses one injected runner for version and dump checks without npx/log side effects', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dshpack-install-doctor-'));
    roots.push(dshHome);
    const profileRoot = join(dshHome, 'profiles', 'demo');
    const packageRoot = join(profileRoot, 'node_modules', 'demo-bundle');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(profileRoot, 'package.json'),
      JSON.stringify({
        dependencies: { 'demo-bundle': '1.0.0' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-bundle'] } },
      }),
    );
    await writeFile(join(profileRoot, 'cordis.patch.yml'), '[]\n');
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'demo-bundle', dsh: { bundle: { patch: 'index.yml' } } }),
    );
    const calls: string[][] = [];
    const pathOnly = async (args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: args.includes('--version') ? '0.1.0-rc.6\n' : '[]\n' };
    };

    await runDoctor(
      {
        dshHome,
        profile: 'demo',
        yes: true,
        nodeVersion: '22.19.0',
        env: { PATH: '' },
      },
      { runDsh: pathOnly },
    );

    expect(calls).toEqual([
      ['--version'],
      ['--profile', 'demo', '--dump-default-config'],
      ['--profile', 'demo', '--dump-default-config'],
    ]);
    expect(processState.defaultCalls).toBe(0);
    await expect(access(join(dshHome, '.dshpack', 'logs'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
