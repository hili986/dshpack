import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Diagnostic } from '@dshpack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  dshError: false,
  dshVersion: '0.1.0-rc.6\n',
  dumpCalls: 0,
  pnpmError: false,
  pnpmExitCode: 0,
  pnpmVersion: '10.0.0\n',
}));

vi.mock('execa', () => ({
  execa: async () => {
    if (state.pnpmError) throw new Error('pnpm unavailable');
    return { exitCode: state.pnpmExitCode, stdout: state.pnpmVersion };
  },
}));

vi.mock('../src/adapters/process.js', () => {
  class DshProcessError extends Error {
    readonly logPath = 'dsh.log';
  }
  return {
    DshProcessError,
    runDsh: async (argv: readonly string[]) => {
      if (state.dshError) throw new DshProcessError('dsh unavailable');
      if (!argv.includes('--version')) state.dumpCalls++;
      return { stdout: argv.includes('--version') ? state.dshVersion : '[]\n' };
    },
  };
});

import {
  checkBuildAuthorization,
  checkBundles,
  checkPnpm,
  checkSettings,
  dshVersion,
} from '../src/doctor/checks.js';
import type { ProfileFacts } from '../src/doctor/support.js';

const temporaryRoots: string[] = [];

async function profile(): Promise<ProfileFacts> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-doctor-checks-'));
  temporaryRoots.push(root);
  return { root, patch: '[]\n', bundles: ['@deepseek-ai/dsh-base'], dependencies: {} };
}

function input(dshHome: string): { dshHome: string; profile: string } {
  return { dshHome, profile: 'demo' };
}

afterEach(async () => {
  state.dshError = false;
  state.dshVersion = '0.1.0-rc.6\n';
  state.dumpCalls = 0;
  state.pnpmError = false;
  state.pnpmExitCode = 0;
  state.pnpmVersion = '10.0.0\n';
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('doctor checks', () => {
  it('distinguishes valid, malformed, and unavailable dsh versions', async () => {
    const diagnostics: Diagnostic[] = [];
    await expect(dshVersion(input('home'), diagnostics)).resolves.toBe('0.1.0-rc.6');
    expect(diagnostics).toEqual([]);

    state.dshVersion = 'not-semver\n';
    await expect(dshVersion(input('home'), diagnostics)).resolves.toBeUndefined();
    state.dshError = true;
    await expect(dshVersion(input('home'), diagnostics)).resolves.toBeUndefined();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DSH003', severity: 'error' }),
        expect.objectContaining({ code: 'DSH003', path: 'dsh.log' }),
      ]),
    );
  });

  it('reports unavailable, too-old, and pnpm-11 environments', async () => {
    const diagnostics: Diagnostic[] = [];
    await checkPnpm(input('home'), diagnostics);
    expect(diagnostics).toEqual([]);

    state.pnpmVersion = '11.7.0\n';
    await checkPnpm(input('home'), diagnostics);
    state.pnpmExitCode = 1;
    await checkPnpm(input('home'), diagnostics);
    state.pnpmError = true;
    await checkPnpm(input('home'), diagnostics);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DSH002', severity: 'warning' }),
        expect.objectContaining({ code: 'DSH002', severity: 'error' }),
      ]),
    );
  });

  it('reconciles every bundle mismatch and installed package failure mode', async () => {
    const facts = await profile();
    facts.bundles.push('not-in-dependencies', 'bad-json', 'without-patch', 'valid-bundle');
    facts.dependencies['bad-json'] = '1.0.0';
    facts.dependencies['without-patch'] = '1.0.0';
    facts.dependencies['valid-bundle'] = '1.0.0';
    facts.dependencies['not-a-bundle'] = '1.0.0';
    await mkdir(join(facts.root, 'node_modules', 'bad-json'), { recursive: true });
    await mkdir(join(facts.root, 'node_modules', 'without-patch'), { recursive: true });
    await mkdir(join(facts.root, 'node_modules', 'valid-bundle'), { recursive: true });
    await writeFile(join(facts.root, 'node_modules', 'bad-json', 'package.json'), '{', 'utf8');
    await writeFile(
      join(facts.root, 'node_modules', 'without-patch', 'package.json'),
      JSON.stringify({ name: 'without-patch' }),
      'utf8',
    );
    await writeFile(
      join(facts.root, 'node_modules', 'valid-bundle', 'package.json'),
      JSON.stringify({ name: 'valid-bundle', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      'utf8',
    );

    const diagnostics: Diagnostic[] = [];
    await checkBundles(facts, input(facts.root), diagnostics);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DSH005', path: 'bad-json' }),
        expect.objectContaining({ code: 'DSH005', path: 'without-patch' }),
        expect.objectContaining({ code: 'DSH005', path: 'not-a-bundle' }),
        expect.objectContaining({ code: 'DSH006', path: 'not-in-dependencies' }),
        expect.objectContaining({ code: 'DSH006', path: 'not-a-bundle' }),
      ]),
    );
    expect(state.dumpCalls).toBe(1);

    state.dshError = true;
    await checkBundles(facts, input(facts.root), diagnostics);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'DSH006', path: 'dsh.log' }));

    const baseOnly = await profile();
    await checkBundles(baseOnly, input(baseOnly.root), diagnostics);
    expect(state.dumpCalls).toBe(1);
  });

  it('fails closed when build authorization cannot be parsed and ignores package forms without scripts', async () => {
    const facts = await profile();
    facts.dependencies['git-build'] = 'git+https://example.test/repo.git#abc';
    facts.dependencies['local-empty'] = 'file:../local-empty';
    facts.dependencies['registry-build'] = '1.0.0';
    for (const name of Object.keys(facts.dependencies)) {
      await mkdir(join(facts.root, 'node_modules', name), { recursive: true });
      await writeFile(
        join(facts.root, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, scripts: name === 'git-build' ? { install: 'node build.mjs' } : {} }),
        'utf8',
      );
    }
    await writeFile(join(facts.root, 'pnpm-workspace.yaml'), '[', 'utf8');
    const diagnostics: Diagnostic[] = [];
    await checkBuildAuthorization(facts, diagnostics);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DSH007', path: join(facts.root, 'pnpm-workspace.yaml') }),
        expect.objectContaining({ code: 'DSH007', path: 'git-build' }),
      ]),
    );

    await writeFile(
      join(facts.root, 'pnpm-workspace.yaml'),
      "allowBuilds:\n  'git-build@git+https://example.test/repo.git#abc': true\n",
      'utf8',
    );
    const authorized: Diagnostic[] = [];
    await checkBuildAuthorization(facts, authorized);
    expect(authorized).toEqual([]);
  });

  it('checks settings parsing, agent-presets shape, secret scan, and an orphan lock independently', async () => {
    const root = await profile();
    const settings = join(root.root, 'settings.yaml');
    const missing: Diagnostic[] = [];
    await checkSettings(root.root, missing);
    expect(missing).toEqual([]);

    await writeFile(settings, '[', 'utf8');
    const malformed: Diagnostic[] = [];
    await checkSettings(root.root, malformed);
    expect(malformed).toContainEqual(expect.objectContaining({ code: 'DSH018', severity: 'error' }));

    await writeFile(settings, 'agent-presets: [invalid]\n', 'utf8');
    await writeFile(`${settings}.lock`, 'pid', 'utf8');
    const invalid: Diagnostic[] = [];
    await checkSettings(root.root, invalid);
    expect(invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DSH018', severity: 'error' }),
        expect.objectContaining({ code: 'DSH018', severity: 'warning' }),
      ]),
    );

    await writeFile(settings, 'agent-presets:\n  apiKey: sk-TESTONLY-01234567890123456789\n', 'utf8');
    const secret: Diagnostic[] = [];
    await checkSettings(root.root, secret);
    expect(secret).toContainEqual(expect.objectContaining({ code: 'DSH018', severity: 'error' }));
    expect(JSON.stringify(secret)).not.toContain('sk-TEST');
  });
});
