import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dumpFails: false,
  marker: undefined as string | undefined,
  profile: undefined as
    | {
        diagnostics: Array<{
          code: string;
          severity: 'error';
          message: string;
          hint: string;
          evidence: 'local';
        }>;
        facts?: {
          bundles: string[];
          dependencies: Record<string, string>;
          patch: string;
          root: string;
        };
      }
    | undefined,
  version: '0.1.0-rc.6' as string | undefined,
}));

vi.mock('../src/doctor/checks.js', () => ({
  checkBuildAuthorization: async () => undefined,
  checkBundles: async () => undefined,
  checkPnpm: async () => undefined,
  checkSettings: async () => undefined,
  dshVersion: async (
    _input: unknown,
    diagnostics: Array<{
      code: string;
      severity: 'error';
      message: string;
      hint: string;
      evidence: 'local';
    }>,
  ) => {
    if (state.version === undefined)
      diagnostics.push({
        code: 'DSH003',
        severity: 'error',
        message: 'missing',
        hint: 'fix',
        evidence: 'local',
      });
    return state.version;
  },
}));

vi.mock('../src/adapters/process.js', () => ({
  runDsh: async () => {
    if (state.dumpFails) throw new Error('dump failed');
    return { stdout: '[]\n' };
  },
}));

vi.mock('../src/doctor/support.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doctor/support.js')>();
  return {
    ...actual,
    readProfile: async () => state.profile ?? { diagnostics: [] },
    skillCandidateFiles: async () => [],
    text: async (path: string) => (path.includes('.dshpack') ? state.marker : undefined),
  };
});

import { runDoctor } from '../src/doctor/engine.js';

const temporary: string[] = [];
afterEach(async () => {
  state.dumpFails = false;
  state.marker = undefined;
  state.profile = undefined;
  state.version = '0.1.0-rc.6';
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('doctor engine orchestration branches', () => {
  it('returns success without a profile and environment failure for an unsupported Node version', async () => {
    await expect(runDoctor({ dshHome: 'ignored' })).resolves.toMatchObject({ exitCode: 0 });
    await expect(runDoctor({ dshHome: 'ignored', nodeVersion: '25.0.0' })).resolves.toMatchObject({
      exitCode: 10,
    });
  });

  it('returns profile contract failure and untracked confirmation refusal', async () => {
    state.profile = {
      diagnostics: [
        { code: 'DSH004', severity: 'error', message: 'bad', hint: 'fix', evidence: 'local' },
      ],
    };
    await expect(runDoctor({ dshHome: 'ignored', profile: 'bad' })).resolves.toMatchObject({
      exitCode: 30,
    });
    const root = await mkdtemp(join(tmpdir(), 'doctor-engine-'));
    temporary.push(root);
    state.profile = {
      diagnostics: [],
      facts: { root, patch: '[]\n', bundles: [], dependencies: {} },
    };
    await expect(runDoctor({ dshHome: 'ignored', profile: 'demo' })).resolves.toMatchObject({
      exitCode: 21,
    });
  });

  it('covers tracked malformed patch, dump failure, and missing dsh version without bypassing engine control flow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doctor-engine-'));
    temporary.push(root);
    state.marker = '{}';
    state.profile = {
      diagnostics: [],
      facts: { root, patch: 'not: an-array\n', bundles: [], dependencies: {} },
    };
    await expect(
      runDoctor({ dshHome: 'ignored', profile: 'demo', yes: true }),
    ).resolves.toMatchObject({ exitCode: 30 });
    state.dumpFails = true;
    await expect(
      runDoctor({ dshHome: 'ignored', profile: 'demo', yes: true }),
    ).resolves.toMatchObject({ exitCode: 30 });
    state.version = undefined;
    await expect(
      runDoctor({ dshHome: 'ignored', profile: 'demo', yes: true }),
    ).resolves.toMatchObject({ exitCode: 10 });
  });
});
