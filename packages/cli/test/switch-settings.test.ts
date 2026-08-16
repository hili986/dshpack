import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindSecureRoot } from '../src/list/safe-fs.js';
import { inspectCurrentAgentPresets, updateSelectedPreset } from '../src/switch/settings.js';

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-switch-settings-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('updateSelectedPreset', () => {
  it('returns false and preserves the file identity when the locked value is already selected', async () => {
    const root = await temporary();
    const path = join(root, 'settings.yaml');
    const contents = '# keep\nagent-presets:\n  selected: alpha\n';
    await writeFile(path, contents, 'utf8');
    const oldTime = new Date('2001-02-03T04:05:06.000Z');
    await utimes(path, oldTime, oldTime);
    const before = await stat(path);

    await expect(updateSelectedPreset(path, 'alpha')).resolves.toMatchObject({
      ok: true,
      value: false,
    });
    expect(await readFile(path, 'utf8')).toBe(contents);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('revalidates the confirmed root before creating a lock through a swapped ancestor', async () => {
    const outer = await temporary();
    const container = join(outer, 'container');
    const home = join(container, 'home');
    const path = join(home, 'settings.yaml');
    await mkdir(home, { recursive: true });
    await writeFile(path, 'agent-presets:\n  selected: old\n', 'utf8');
    const root = await bindSecureRoot(home);
    if (!root.ok) throw new Error('fixture root failed');
    const moved = join(outer, 'container-moved');
    const writeLockContents = vi.fn(async () => undefined);
    let swapped = false;

    await expect(
      updateSelectedPreset(path, 'new', { writeLockContents }, root.value, {
        afterPreLockRevalidate: async () => {
          await rename(container, moved);
          await symlink(moved, container, 'junction');
          swapped = true;
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_PATH_SETTINGS' })],
    });
    expect(swapped).toBe(true);
    expect(writeLockContents).not.toHaveBeenCalled();
    await expect(lstat(join(moved, 'home', 'settings.yaml.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('creates a missing document and updates only the selected leaf', async () => {
    const root = await temporary();
    const path = join(root, 'settings.yaml');
    await expect(updateSelectedPreset(path, 'alpha')).resolves.toMatchObject({ ok: true });
    expect(await readFile(path, 'utf8')).toContain('selected: alpha');

    await writeFile(
      path,
      '# root\nagent-presets:\n  selected: old\n  keep: yes\nui-theme: dark\n',
      'utf8',
    );
    await expect(updateSelectedPreset(path, 'beta')).resolves.toMatchObject({ ok: true });
    const changed = await readFile(path, 'utf8');
    expect(changed).toContain('# root');
    expect(changed).toContain('selected: beta');
    expect(changed).toContain('keep: yes');
    expect(changed).toContain('ui-theme: dark');
  });

  it.each([
    ['invalid YAML', 'agent-presets: [unterminated\n', 'E_SETTINGS_INVALID_YAML'],
    ['non-map root', '- item\n', 'E_SETTINGS_ROOT'],
    ['non-map namespace', 'agent-presets: [item]\n', 'E_SWITCH_SETTINGS'],
    [
      'alias namespace',
      'shared: &shared\n  selected: old\nagent-presets: *shared\n',
      'E_SETTINGS_ALIAS',
    ],
    [
      'anchored namespace',
      'agent-presets: &shared\n  selected: old\nother: *shared\n',
      'E_SETTINGS_ALIAS',
    ],
  ])('rejects %s without changing bytes', async (_name, contents, code) => {
    const root = await temporary();
    const path = join(root, 'settings.yaml');
    await writeFile(path, contents, 'utf8');
    const result = await updateSelectedPreset(path, 'alpha');
    expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code })] });
    expect(await readFile(path, 'utf8')).toBe(contents);
  });

  it('rejects secrets in the resulting namespace without changing bytes', async () => {
    const root = await temporary();
    const path = join(root, 'settings.yaml');
    const contents =
      'agent-presets:\n  token: sk-TESTONLY-012345678901234567890123\n  selected: old\n';
    await writeFile(path, contents, 'utf8');
    const result = await updateSelectedPreset(path, 'alpha');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain('E_SECRET_TOKEN');
    expect(await readFile(path, 'utf8')).toBe(contents);
  });

  it('returns precise IO and lock failures without touching the target', async () => {
    const root = await temporary();
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'file', 'utf8');
    await expect(
      updateSelectedPreset(join(blocker, 'settings.yaml'), 'alpha'),
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_IO' })],
    });

    const path = join(root, 'settings.yaml');
    await writeFile(path, 'agent-presets: {}\n', 'utf8');
    await writeFile(`${path}.lock`, 'other\n', 'utf8');
    let now = 0;
    const result = await updateSelectedPreset(path, 'alpha', {
      clock: {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_LOCK_TIMEOUT' })],
    });
    expect(await readFile(path, 'utf8')).toBe('agent-presets: {}\n');
  });

  it('rejects a settings directory before preflight or lock-scoped RMW', async () => {
    const root = await temporary();
    const path = join(root, 'settings.yaml');
    await mkdir(path);
    await expect(inspectCurrentAgentPresets(path)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_PATH_SETTINGS' })],
    });
    await expect(updateSelectedPreset(path, 'alpha')).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_PATH_SETTINGS' })],
    });
  });

  it('reads only agent-presets and never expands aliases in unrelated namespaces', async () => {
    const root = await temporary();
    const path = join(root, 'settings.yaml');
    const aliases = Array.from({ length: 101 }, () => '*base').join(', ');
    await writeFile(
      path,
      `base: &base [one]\nbomb: [${aliases}]\nagent-presets:\n  selected: old\n`,
      'utf8',
    );
    await expect(inspectCurrentAgentPresets(path)).resolves.toMatchObject({
      ok: true,
      value: { selected: 'old' },
    });
    await expect(updateSelectedPreset(path, 'new')).resolves.toMatchObject({ ok: true });
    expect(await readFile(path, 'utf8')).toContain('selected: new');
  });

  it('rejects a settings path whose parent resolves through a junction', async () => {
    const root = await temporary();
    const target = join(root, 'target');
    const linked = join(root, 'linked');
    await mkdir(target);
    await symlink(target, linked, 'junction');
    await expect(inspectCurrentAgentPresets(join(linked, 'settings.yaml'))).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'E_PATH_SETTINGS' })],
    });
  });
});
