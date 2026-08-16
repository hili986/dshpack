import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type SwitchRuntime, switchProfile } from '../src/switch/engine.js';
import { securityTrackedHome } from './list-switch-security-fixture.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function runtime(overrides: Partial<SwitchRuntime> = {}): SwitchRuntime {
  return {
    confirm: vi.fn(async () => false),
    isTTY: true,
    showDiff: vi.fn(),
    spawnDsh: vi.fn(async () => 0),
    ...overrides,
  };
}

describe('switch reviewed selected CAS', () => {
  it('fails closed when selected drifts after diff confirmation and preserves concurrent bytes', async () => {
    const home = await securityTrackedHome('switch-selected-cas');
    roots.push(home);
    const path = join(home, 'settings.yaml');
    await writeFile(path, 'agent-presets:\n  selected: old\nother: before\n', 'utf8');
    const concurrent =
      '# concurrent\nagent-presets:\n  selected: concurrent\n  keep: true\nother: after\n';
    const deps = runtime({
      confirm: vi.fn(async () => {
        await writeFile(path, concurrent, 'utf8');
        return true;
      }),
    });

    const report = await switchProfile(
      { dshHome: home, profile: 'demo', setDefaultPreset: true },
      deps,
    );

    expect(deps.showDiff).toHaveBeenCalledOnce();
    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_SWITCH_SETTINGS_CHANGED' })],
      metadata: { ran: false, settingsChanged: false },
    });
    expect(await readFile(path, 'utf8')).toBe(concurrent);
    expect(deps.spawnDsh).not.toHaveBeenCalled();
  });
});
