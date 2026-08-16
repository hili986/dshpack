import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type SwitchRuntime, switchProfile } from '../src/switch/engine.js';
import {
  securityHome,
  securityProfile,
  securityTrackedHome,
  writeSecurityMarker,
} from './list-switch-security-fixture.js';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const home = await securityTrackedHome();
  roots.push(home);
  return home;
}

async function quotedFixture(): Promise<string> {
  const base = await securityHome('switch-quote');
  roots.push(base);
  const home = join(base, "home' ; Write-Output PWN");
  await securityProfile(home);
  await writeSecurityMarker(home);
  const preset = join(home, '.agent-presets', 'demo-preset');
  await mkdir(preset, { recursive: true });
  await writeFile(join(preset, 'agent.cordis.yml'), '[]\n', 'utf8');
  return home;
}

function runtime(overrides: Partial<SwitchRuntime> = {}): SwitchRuntime {
  return {
    confirm: vi.fn(async () => false),
    isTTY: true,
    showDiff: vi.fn(),
    spawnDsh: vi.fn(async () => 0),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('switch confirmation output safety', () => {
  it('never invokes an interactive prompt in JSON mode and preserves requested flags', async () => {
    const home = await fixture();
    const deps = runtime();
    const report = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true, json: true },
      deps,
    );
    expect(report.exitCode).toBe(21);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(report.diagnostics[0]?.hint).toContain('--set-default-preset --json --yes');

    const withRun = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true, run: true },
      runtime({ isTTY: false }),
    );
    expect(withRun.exitCode).toBe(21);
    expect(withRun.diagnostics[0]?.hint).toContain('--run --set-default-preset --yes');

    const quotedHome = await quotedFixture();
    const quoted = await switchProfile(
      { dshHome: quotedHome, profile: 'demo', setDefaultPreset: true, json: true },
      runtime(),
    );
    const expectedPath =
      process.platform === 'win32'
        ? `'${quotedHome.replaceAll("'", "''")}'`
        : `'${quotedHome.replaceAll("'", `'"'"'`)}'`;
    expect(quoted.diagnostics[0]?.hint).toContain(`--dsh-home ${expectedPath}`);
  });

  it.each([
    'agent-presets:\n  selected: sk-TESTONLY-012345678901234567890123\n',
    'agent-presets:\n  selected: safe\n  nested:\n    token: sk-TESTONLY-012345678901234567890123\n',
  ])('rejects current secrets before rendering a diff or prompt', async (settings) => {
    const home = await fixture();
    const path = join(home, 'settings.yaml');
    const deps = runtime();
    await writeFile(path, settings, 'utf8');
    const report = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true, yes: true },
      deps,
    );
    expect(report.exitCode).toBe(31);
    expect(deps.showDiff).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain('sk-TESTONLY');
    expect(await readFile(path, 'utf8')).toBe(settings);
  });

  it('separates path/control injection from an ordinary invalid profile name', async () => {
    const home = await fixture();
    await expect(
      switchProfile({ dshHome: home, profile: '../demo' }, runtime()),
    ).resolves.toMatchObject({ exitCode: 31 });
    await expect(
      switchProfile({ dshHome: home, profile: 'bad\nname' }, runtime()),
    ).resolves.toMatchObject({ exitCode: 31 });
    await expect(
      switchProfile({ dshHome: home, profile: 'BadName' }, runtime()),
    ).resolves.toMatchObject({ exitCode: 30 });
  });
});

describe('switch subprocess facts', () => {
  it('reports a spawned nonzero child and preceding settings mutation truthfully', async () => {
    const home = await fixture();
    const report = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true, yes: true, run: true },
      runtime({ spawnDsh: vi.fn(async () => 9) }),
    );
    expect(report).toMatchObject({
      exitCode: 23,
      metadata: { ran: true, settingsChanged: true, effect: 'new-session' },
    });
  });

  it('preserves settings facts when foreground spawn itself fails before starting', async () => {
    const home = await fixture();
    const report = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true, yes: true, run: true },
      runtime({ spawnDsh: vi.fn(async () => Promise.reject(new Error('ENOENT'))) }),
    );
    expect(report).toMatchObject({
      exitCode: 10,
      metadata: { ran: false, settingsChanged: true, effect: 'new-session' },
    });
  });
});
