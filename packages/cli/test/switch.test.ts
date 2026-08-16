import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type SwitchRuntime, switchProfile } from '../src/switch/engine.js';

const homes: string[] = [];
const SHA256_A = `sha256-${'a'.repeat(43)}`;
const SHA256_B = `sha256-${'b'.repeat(43)}`;

async function fixture(tracked = true): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dshpack-switch-'));
  homes.push(home);
  const profile = join(home, 'profiles', 'demo');
  await mkdir(profile, { recursive: true });
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-demo',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }),
    'utf8',
  );
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', 'utf8');
  await writeFile(
    join(profile, 'pnpm-workspace.yaml'),
    "packages: ['.']\nnodeLinker: hoisted\nautoInstallPeers: false\n",
    'utf8',
  );
  await mkdir(join(home, '.agent-presets', 'demo-preset'), { recursive: true });
  await writeFile(join(home, '.agent-presets', 'demo-preset', 'agent.cordis.yml'), '[]\n');
  if (tracked) {
    await mkdir(join(home, '.dshpack', 'installed'), { recursive: true });
    await writeFile(
      join(home, '.dshpack', 'installed', 'demo.json'),
      JSON.stringify({
        metadataVersion: 0,
        profile: 'demo',
        pack: { name: 'demo-pack', version: '1.0.0', manifestDigest: SHA256_A },
        planDigest: SHA256_B,
        installedAt: '2026-08-16T00:00:00.000Z',
        txid: 'tx',
        source: { kind: 'directory', path: home },
        defaults: { agentPreset: 'demo-preset', permissionPreset: 'workspace-write' },
        plugins: [],
        sideEffects: ['profile/cordis.yml'],
      }),
      'utf8',
    );
  }
  return home;
}

function runtime(overrides: Partial<SwitchRuntime> = {}): SwitchRuntime {
  return {
    confirm: vi.fn(async () => false),
    isTTY: false,
    showDiff: vi.fn(),
    spawnDsh: vi.fn(async () => 0),
    ...overrides,
  };
}

async function editMarker(home: string, edit: (value: Record<string, unknown>) => void) {
  const path = join(home, '.dshpack', 'installed', 'demo.json');
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  edit(value);
  await writeFile(path, JSON.stringify(value), 'utf8');
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(homes.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('switchProfile', () => {
  it('only validates and returns the exact launch command by default', async () => {
    const home = await fixture(false);
    const deps = runtime();

    const report = await switchProfile({ dshHome: home, profile: 'demo' }, deps);

    expect(report).toMatchObject({
      exitCode: 0,
      metadata: {
        command: 'dsh --profile demo',
        profile: 'demo',
        ran: false,
        settingsChanged: false,
      },
    });
    expect(deps.spawnDsh).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.showDiff).not.toHaveBeenCalled();
  });

  it('spawns dsh in the foreground only with --run', async () => {
    const home = await fixture();
    const deps = runtime({ spawnDsh: vi.fn(async () => 0) });
    const report = await switchProfile({ dshHome: home, profile: 'demo', run: true }, deps);
    expect(report.exitCode).toBe(0);
    expect(report.metadata.ran).toBe(true);
    expect(deps.spawnDsh).toHaveBeenCalledWith('demo', home);
  });

  it('rejects --run with JSON before spawning', async () => {
    const home = await fixture();
    const deps = runtime();
    await expect(
      switchProfile({ dshHome: home, profile: 'demo', run: true, json: true }, deps),
    ).resolves.toMatchObject({
      exitCode: 2,
      diagnostics: [expect.objectContaining({ code: 'E_SWITCH_JSON_RUN' })],
    });
    expect(deps.spawnDsh).not.toHaveBeenCalled();
  });

  it('shows a settings diff before a default-rejecting interactive prompt', async () => {
    const home = await fixture();
    const order: string[] = [];
    const deps = runtime({
      isTTY: true,
      showDiff: vi.fn(() => order.push('diff')),
      confirm: vi.fn(async () => {
        order.push('confirm');
        return false;
      }),
    });
    const settings = '# keep\nagent-presets:\n  selected: old\n  keep: true\n';
    await writeFile(join(home, 'settings.yaml'), settings, 'utf8');

    const report = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true },
      deps,
    );

    expect(order).toEqual(['diff', 'confirm']);
    expect(deps.showDiff).toHaveBeenCalledWith(
      expect.stringContaining('- agent-presets.selected: "old"'),
    );
    expect(deps.showDiff).toHaveBeenCalledWith(
      expect.stringContaining('+ agent-presets.selected: demo-preset'),
    );
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    expect(report.exitCode).toBe(21);
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toBe(settings);
  });

  it('prints a complete non-TTY command and does not write without --yes', async () => {
    const home = await fixture();
    const deps = runtime();
    const report = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true },
      deps,
    );
    expect(report.exitCode).toBe(21);
    const hint = report.diagnostics[0]?.hint ?? '';
    expect(hint).toContain(home);
    expect(hint).toContain('switch demo --set-default-preset --yes');
    await expect(readFile(join(home, 'settings.yaml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('preserves comments and other leaves after --yes, and never spawns implicitly', async () => {
    const home = await fixture();
    const deps = runtime();
    await writeFile(
      join(home, 'settings.yaml'),
      '# root comment\nui-theme: dark\nagent-presets:\n  # leaf comment\n  selected: old\n  keep: yes\n',
      'utf8',
    );

    const report = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true, yes: true },
      deps,
    );

    expect(report.exitCode).toBe(0);
    expect(report.metadata).toMatchObject({ effect: 'new-session', settingsChanged: true });
    const changed = await readFile(join(home, 'settings.yaml'), 'utf8');
    expect(changed).toContain('# root comment');
    expect(changed).toContain('# leaf comment');
    expect(changed).toContain('ui-theme: dark');
    expect(changed).toContain('keep: yes');
    expect(changed).toContain('selected: demo-preset');
    expect(deps.showDiff).toHaveBeenCalledOnce();
    expect(deps.spawnDsh).not.toHaveBeenCalled();
  });

  it('re-reads under the settings lock and preserves a post-diff concurrent mutation', async () => {
    const home = await fixture();
    const path = join(home, 'settings.yaml');
    await writeFile(path, 'agent-presets:\n  selected: old\nother: before\n', 'utf8');
    const deps = runtime({
      isTTY: true,
      confirm: vi.fn(async () => {
        await writeFile(
          path,
          'agent-presets:\n  selected: concurrent\n  concurrent-leaf: keep\nother: after\n',
          'utf8',
        );
        return true;
      }),
    });

    const report = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true },
      deps,
    );

    expect(report.exitCode).toBe(0);
    const changed = await readFile(path, 'utf8');
    expect(changed).toContain('selected: demo-preset');
    expect(changed).toContain('concurrent-leaf: keep');
    expect(changed).toContain('other: after');
  });

  it('rejects missing, broken, untracked-default, and absent preset contracts minimally', async () => {
    const missingHome = await fixture();
    expect(
      (await switchProfile({ dshHome: missingHome, profile: 'missing' }, runtime())).diagnostics[0]
        ?.message,
    ).toBe('profile 不存在。');

    const untrackedHome = await fixture(false);
    expect(
      (
        await switchProfile(
          { dshHome: untrackedHome, profile: 'demo', setDefaultPreset: true, yes: true },
          runtime(),
        )
      ).diagnostics[0]?.message,
    ).toBe('该 profile 没有 dshpack installed metadata，无法确定默认 preset。');

    const brokenHome = await fixture();
    await writeFile(join(brokenHome, 'profiles', 'demo', 'package.json'), '{}', 'utf8');
    expect(
      (await switchProfile({ dshHome: brokenHome, profile: 'demo' }, runtime())).exitCode,
    ).toBe(30);

    const absentPresetHome = await fixture();
    const { rm } = await import('node:fs/promises');
    await rm(join(absentPresetHome, '.agent-presets', 'demo-preset'), { recursive: true });
    expect(
      (
        await switchProfile(
          { dshHome: absentPresetHome, profile: 'demo', setDefaultPreset: true, yes: true },
          runtime(),
        )
      ).diagnostics[0]?.message,
    ).toBe('installed metadata 指定的默认 preset 不存在。');

    const noDefaultHome = await fixture();
    await editMarker(noDefaultHome, (value) => {
      value.defaults = { permissionPreset: 'workspace-write' };
    });
    expect(
      (
        await switchProfile(
          { dshHome: noDefaultHome, profile: 'demo', setDefaultPreset: true, yes: true },
          runtime(),
        )
      ).diagnostics[0]?.message,
    ).toBe('installed metadata 没有默认 preset。');

    const brokenMarkerHome = await fixture();
    await editMarker(brokenMarkerHome, (value) => {
      value.metadataVersion = 99;
    });
    await expect(
      switchProfile(
        { dshHome: brokenMarkerHome, profile: 'demo', setDefaultPreset: true, yes: true },
        runtime(),
      ),
    ).resolves.toMatchObject({ exitCode: 30 });
    await expect(
      switchProfile({ dshHome: brokenMarkerHome, profile: 'demo' }, runtime()),
    ).resolves.toMatchObject({ exitCode: 30 });
  });

  it('maps environment, invalid names, settings failures, and child failures to exact exits', async () => {
    await expect(switchProfile({ dshHome: '', profile: 'demo' }, runtime())).resolves.toMatchObject(
      {
        exitCode: 10,
      },
    );
    const home = await fixture();
    await expect(
      switchProfile({ dshHome: home, profile: '../demo' }, runtime()),
    ).resolves.toMatchObject({ exitCode: 31 });
    await writeFile(join(home, 'settings.yaml'), 'agent-presets: [bad]\n', 'utf8');
    await expect(
      switchProfile(
        { dshHome: home, profile: 'demo', setDefaultPreset: true, yes: true },
        runtime(),
      ),
    ).resolves.toMatchObject({ exitCode: 30 });
    await expect(
      switchProfile(
        { dshHome: home, profile: 'demo', run: true },
        runtime({ spawnDsh: vi.fn(async () => 9) }),
      ),
    ).resolves.toMatchObject({ exitCode: 23 });
    await expect(
      switchProfile(
        { dshHome: home, profile: 'demo', run: true },
        runtime({ spawnDsh: vi.fn(async () => Promise.reject(new Error('ENOENT'))) }),
      ),
    ).resolves.toMatchObject({ exitCode: 10 });
  });

  it('rejects malformed YAML, null sections, aliases, and secret-bearing sections', async () => {
    const malformed = await fixture();
    await writeFile(join(malformed, 'settings.yaml'), 'agent-presets: [unterminated\n', 'utf8');
    await expect(
      switchProfile(
        { dshHome: malformed, profile: 'demo', setDefaultPreset: true, yes: true },
        runtime(),
      ),
    ).resolves.toMatchObject({ exitCode: 30 });

    const nullSection = await fixture();
    await writeFile(join(nullSection, 'settings.yaml'), 'agent-presets: null\n', 'utf8');
    await expect(
      switchProfile(
        { dshHome: nullSection, profile: 'demo', setDefaultPreset: true, yes: true },
        runtime(),
      ),
    ).resolves.toMatchObject({ exitCode: 30 });

    const alias = await fixture();
    await writeFile(
      join(alias, 'settings.yaml'),
      'agent-presets: &shared\n  selected: old\nother: *shared\n',
      'utf8',
    );
    await expect(
      switchProfile(
        { dshHome: alias, profile: 'demo', setDefaultPreset: true, yes: true },
        runtime(),
      ),
    ).resolves.toMatchObject({ exitCode: 30 });

    const secret = await fixture();
    await writeFile(
      join(secret, 'settings.yaml'),
      'agent-presets:\n  token: sk-TESTONLY-012345678901234567890123\n',
      'utf8',
    );
    await expect(
      switchProfile(
        { dshHome: secret, profile: 'demo', setDefaultPreset: true, yes: true },
        runtime(),
      ),
    ).resolves.toMatchObject({ exitCode: 31 });
  });
});
