import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerUninstallCommand } from '../src/commands/uninstall.js';
import { installPack } from '../src/install/engine.js';
import { terminalSafeText } from '../src/terminal-safe.js';
import { uninstallProfile } from '../src/uninstall/engine.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

const TEST_DSH_HOME = resolve('uninstall-command-home');
const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-uninstall-command-'));
  roots.push(root);
  return root;
}

function program(): Command {
  return new Command().name('dshpack').exitOverride().option('--dsh-home <path>').option('--json');
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stdout, stderr };
}

afterEach(async () => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('uninstall command registration', () => {
  it('escapes an astral Unicode format control without emitting the raw control', () => {
    const tag = String.fromCodePoint(0xe0001);

    expect(terminalSafeText(`before${tag}after`)).toBe('before\\u{e0001}after');
  });

  it('renders the non-JSON plan, including destructive and uncertain items', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo-pack',
        dryRun: true,
        keepAssets: false,
        force: true,
        purgeGenerations: false,
        removedMarker: false,
        activation: 'unchanged' as const,
        profileAction: 'none' as const,
        markerAction: 'none' as const,
        assets: [
          {
            target: 'skills/modified',
            drift: 'modified' as const,
            action: 'delete' as const,
            reason: 'force-modified' as const,
          },
          {
            target: 'skills/shared',
            drift: 'intact' as const,
            action: 'retain' as const,
            reason: 'legacy-profile-reference' as const,
          },
        ],
        legacyProfiles: ['legacy-peer'],
        settingsRemoved: ['managed'],
        settingsRetained: ['user-edit'],
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'uninstall',
      'demo-pack',
      '--dry-run',
    ]);

    const output = io.stdout.join('');
    expect(output).toContain('Uninstall plan:');
    expect(output).toContain('delete skills/modified (force-modified)');
    expect(output).toContain('retain skills/shared (legacy-profile-reference)');
    expect(output).toContain('legacy-peer');
    expect(output).toContain('delete settings agent-presets.managed');
    expect(output).toContain('retain settings agent-presets.user-edit');
  });

  it('forwards every uninstall safety flag and emits exactly one JSON report', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo-pack',
        dryRun: true,
        keepAssets: true,
        force: true,
        purgeGenerations: true,
        removedMarker: false,
        activation: 'unchanged' as const,
        profileAction: 'none' as const,
        markerAction: 'none' as const,
        assets: [],
        legacyProfiles: [],
        settingsRemoved: [],
        settingsRetained: [],
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      '--json',
      'uninstall',
      'demo-pack',
      '--dry-run',
      '--keep-assets',
      '--force',
      '--purge-generations',
      '--yes',
    ]);

    expect(run).toHaveBeenCalledWith({
      dshHome: TEST_DSH_HOME,
      profile: 'demo-pack',
      dryRun: true,
      keepAssets: true,
      force: true,
      purgeGenerations: true,
      yes: true,
      interactive: false,
    });
    expect(io.stderr).toEqual([]);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({ profile: 'demo-pack', dryRun: true });
  });

  it('rejects unsafe DSH_HOME before reaching the uninstall engine', async () => {
    const io = capture();
    const run = vi.fn();
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      'relative',
      '--json',
      'uninstall',
      'demo',
    ]);

    expect(run).not.toHaveBeenCalled();
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_PATH_DSH_HOME' })],
    });
  });

  it('prints the executable retain plan before a normal confirmation error', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [
        {
          code: 'E_UNINSTALL_CONFIRM_REQUIRED',
          severity: 'error' as const,
          message: 'confirmation required',
          hint: 'use --yes',
          evidence: 'local' as const,
        },
      ],
      exitCode: 21 as const,
      metadata: {
        profile: 'demo-pack',
        dryRun: true,
        keepAssets: false,
        force: false,
        purgeGenerations: true,
        removedMarker: false,
        activation: 'unchanged' as const,
        profileAction: 'none' as const,
        markerAction: 'none' as const,
        assets: [
          {
            target: 'skills/notes',
            drift: 'modified' as const,
            action: 'retain' as const,
            reason: 'modified' as const,
          },
        ],
        legacyProfiles: ['legacy-peer'],
        settingsRemoved: [],
        settingsRetained: ['custom'],
        deletedGenerations: ['.dshpack/generations/demo-pack/0001.json'],
        deletedBlocks: ['sha256-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO'],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'uninstall',
      'demo-pack',
      '--purge-generations',
    ]);

    expect(io.stdout.join('')).toContain('Uninstall plan:');
    expect(io.stdout.join('')).toContain('retain skills/notes (modified)');
    expect(io.stdout.join('')).toContain('rerun the same command with --yes');
    expect(io.stdout.join('')).toContain('.dshpack/generations/demo-pack/0001.json');
    expect(io.stderr.join('')).toContain('E_UNINSTALL_CONFIRM_REQUIRED');
  });

  it('keeps --force in the executable plan for a force-modified legacy cleanup', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 21 as const,
      metadata: {
        profile: 'legacy-pack',
        dryRun: false,
        keepAssets: false,
        force: true,
        purgeGenerations: false,
        removedMarker: false,
        activation: 'unchanged' as const,
        profileAction: 'none' as const,
        markerAction: 'none' as const,
        assets: [
          {
            target: 'skills/notes',
            drift: 'modified' as const,
            action: 'delete' as const,
            reason: 'force-modified' as const,
          },
        ],
        legacyProfiles: [],
        settingsRemoved: [],
        settingsRetained: [],
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'uninstall',
      'legacy-pack',
      '--force',
    ]);

    expect(io.stdout.join('')).toContain('delete skills/notes (force-modified)');
    expect(io.stdout.join('')).toContain('--force');
  });

  it('labels a completed normal uninstall as executed rather than future work', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo-pack',
        dryRun: false,
        keepAssets: false,
        force: false,
        purgeGenerations: false,
        removedMarker: true,
        activation: 'profile-removed' as const,
        profileAction: 'delete' as const,
        markerAction: 'delete' as const,
        assets: [],
        legacyProfiles: [],
        settingsRemoved: [],
        settingsRetained: [],
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'uninstall',
      'demo-pack',
      '--yes',
    ]);

    expect(io.stdout.join('')).toContain('Uninstall completed.');
    expect(io.stdout.join('')).not.toContain('Execute:');
    expect(io.stdout.join('')).toContain('restart dsh');
  });

  it('reports a retained profile activation without asking for an unnecessary restart', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo-pack',
        dryRun: false,
        keepAssets: false,
        force: false,
        purgeGenerations: false,
        removedMarker: true,
        activation: 'unchanged' as const,
        profileAction: 'retain' as const,
        markerAction: 'delete' as const,
        assets: [],
        legacyProfiles: [],
        settingsRemoved: [],
        settingsRetained: [],
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'uninstall',
      'demo-pack',
      '--yes',
    ]);

    expect(io.stdout.join('')).toContain('profile was retained');
    expect(io.stdout.join('')).not.toContain('restart dsh');
  });

  it('renders the real forced-v0 profile and marker deletion plan before confirmation', async () => {
    const io = capture();
    const dshHome = await home();
    await expect(
      installPack(
        { source: await enginePack({ assets: true }), dshHome, interactive: false, yes: true },
        fakeRuntime().runtime,
      ),
    ).resolves.toMatchObject({ exitCode: 0 });
    const markerPath = join(dshHome, '.dshpack', 'installed', 'engine-pack.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    delete marker.assets;
    delete marker.settingsContribution;
    delete marker.generation;
    delete marker.installedBy;
    marker.metadataVersion = 0;
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
    const report = await uninstallProfile({
      dshHome,
      profile: 'engine-pack',
      force: true,
      dryRun: true,
    });
    const run = vi.fn(async () => report);
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      dshHome,
      'uninstall',
      'engine-pack',
      '--force',
      '--dry-run',
    ]);

    expect(report.metadata).toMatchObject({ profileAction: 'delete', markerAction: 'delete' });
    expect(io.stdout.join('')).toContain('delete profile directory (legacy-force)');
    expect(io.stdout.join('')).toContain('delete tracked installed marker');
  });

  it('does not render an untrusted plan for an arbitrary engine error', async () => {
    const io = capture();
    const run = vi.fn(async () => ({
      diagnostics: [
        {
          code: 'E_UNINSTALL_METADATA',
          severity: 'error' as const,
          message: 'bad state',
          hint: 'repair it',
          evidence: 'local' as const,
        },
      ],
      exitCode: 30 as const,
      metadata: {
        profile: 'bad\u0007profile',
        dryRun: false,
        keepAssets: false,
        force: false,
        purgeGenerations: false,
        removedMarker: false,
        activation: 'unchanged' as const,
        profileAction: 'none' as const,
        markerAction: 'none' as const,
        assets: [],
        legacyProfiles: [],
        settingsRemoved: [],
        settingsRetained: [],
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'uninstall',
      'demo-pack',
    ]);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('')).toContain('E_UNINSTALL_METADATA');
  });

  it('escapes persisted control characters in a human settings plan', async () => {
    const io = capture();
    const controlKey = '\u001b[2J';
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo-pack',
        dryRun: true,
        keepAssets: false,
        force: false,
        purgeGenerations: false,
        removedMarker: false,
        activation: 'unchanged' as const,
        profileAction: 'none' as const,
        markerAction: 'none' as const,
        assets: [],
        legacyProfiles: [],
        settingsRemoved: [controlKey],
        settingsRetained: [],
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'uninstall',
      'demo-pack',
      '--dry-run',
    ]);

    expect(io.stdout.join('')).toContain('agent-presets.\\u001b[2J');
    expect(io.stdout.join('')).not.toContain(controlKey);
  });

  it('escapes Unicode line and bidi controls in a human settings plan', async () => {
    const io = capture();
    const unsafeKey = 'line\u2028reordered\u202epreset';
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profile: 'demo-pack',
        dryRun: true,
        keepAssets: false,
        force: false,
        purgeGenerations: false,
        removedMarker: false,
        activation: 'unchanged' as const,
        profileAction: 'none' as const,
        markerAction: 'none' as const,
        assets: [],
        legacyProfiles: [],
        settingsRemoved: [],
        settingsRetained: [unsafeKey],
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    }));
    const cli = program();
    registerUninstallCommand(cli, run);

    await cli.parseAsync([
      'node',
      'dshpack',
      '--dsh-home',
      TEST_DSH_HOME,
      'uninstall',
      'demo-pack',
      '--dry-run',
    ]);

    expect(io.stdout.join('')).toContain('agent-presets.line\\u2028reordered\\u202epreset');
    expect(io.stdout.join('')).not.toContain(unsafeKey);
  });
});
