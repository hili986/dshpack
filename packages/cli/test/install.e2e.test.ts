import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { enginePack } from './install-engine-fixture.js';

const binPath =
  process.env.DSHPACK_E2E_BIN === undefined
    ? fileURLToPath(new URL('../dist/bin.js', import.meta.url))
    : resolve(process.env.DSHPACK_E2E_BIN);
const shimDirectory = fileURLToPath(new URL('./e2e/install-shims/', import.meta.url));
const roots: string[] = [];

async function fixture(): Promise<{ home: string; env: NodeJS.ProcessEnv; log: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-install-e2e-'));
  roots.push(root);
  const home = join(root, 'home');
  await mkdir(home);
  const childEnvironment = { ...process.env };
  // This built CLI recursively spawns the PATH-first dsh/pnpm shims. They are
  // outside Vitest's source instrumentation and must not contend for its V8
  // coverage scratch directory.
  delete childEnvironment.NODE_V8_COVERAGE;
  return {
    home,
    log: join(root, 'shim.jsonl'),
    env: {
      ...childEnvironment,
      DSH_HOME: home,
      PATH: [shimDirectory, dirname(process.execPath)].join(delimiter),
      DSHPACK_NODE_EXE: process.execPath,
      DSHPACK_INSTALL_SHIM_LOG: join(root, 'shim.jsonl'),
    },
  };
}

function run(home: string, env: NodeJS.ProcessEnv, args: readonly string[]) {
  return spawnSync(process.execPath, [binPath, '--dsh-home', home, ...args], {
    encoding: 'utf8',
    env,
    timeout: 20_000,
  });
}

async function emptyHome(home: string): Promise<boolean> {
  return (await readdir(home)).length === 0;
}

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('built install with an isolated PATH-first dsh/pnpm shim', () => {
  it('installs a local pack, lists it as tracked, and passes doctor --strict', async () => {
    const { env, home, log } = await fixture();
    const source = await enginePack({ assets: true, mcp: true, plugin: {} });
    const installed = run(home, env, ['install', source, '--yes']);
    expect(installed.status).toBe(0);
    expect(installed.stderr).toContain('rollback snapshot: enabled=true');
    expect(installed.stdout).toContain('dsh --profile engine-pack');
    expect(installed.stdout).toContain('--dump-config');
    expect(installed.stderr).not.toContain('未实现');

    const listed = run(home, env, ['--json', 'list']);
    expect(listed.status).toBe(0);
    expect(listed.stderr).toBe('');
    expect(JSON.parse(listed.stdout)).toMatchObject({
      profiles: [{ profile: 'engine-pack', status: 'tracked' }],
    });

    const doctor = run(home, env, ['--json', 'doctor', '--profile', 'engine-pack', '--strict']);
    expect(doctor.status).toBe(0);
    expect(doctor.stderr).toBe('');
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      profile: 'engine-pack',
      sideEffects: [
        { owner: 'dsh', path: 'profile/cordis.yml' },
        { owner: 'dshpack', path: '.dshpack/logs/<file>' },
      ],
    });
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('agent-presets');
    const profilePatch = await readFile(
      join(home, 'profiles', 'engine-pack', 'cordis.patch.yml'),
      'utf8',
    );
    const profileRows = parse(profilePatch) as Array<{ insert?: unknown[] }>;
    expect(profileRows.flatMap((row) => row.insert ?? [])).toContainEqual({
      id: 'mcp-docs',
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: 'docs',
        transport: 'streamable-http',
        url: 'https://mcp.example/docs',
      },
    });
    expect(await readFile(join(home, 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain('fixture');
    expect(await readFile(join(home, '.agent-presets', 'custom', 'agent.cordis.yml'), 'utf8')).toBe(
      '[]\n',
    );
    await expect(
      access(join(home, '.dshpack', 'installed', 'engine-pack.json')),
    ).resolves.toBeUndefined();
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            argv: string[];
            cwd: string;
            dshHome: string;
            ignoreScripts: string;
            tool: string;
          },
      );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(({ dshHome }) => dshHome === home)).toBe(true);
    expect(calls.every(({ tool }) => tool === 'dsh' || tool === 'pnpm')).toBe(true);
    const resolver = calls.find(({ argv, tool }) => tool === 'pnpm' && argv[0] === 'add');
    expect(resolver).toBeDefined();
    expect(resolver?.argv).toEqual(
      expect.arrayContaining([
        '--store-dir',
        '--cache-dir',
        '--state-dir',
        'example-bundle@^1.0.0',
      ]),
    );
    expect(resolver?.cwd.startsWith(home)).toBe(false);
    expect(resolver?.cwd.startsWith(source)).toBe(false);
    expect(resolver?.ignoreScripts).toBe('true');
    const pluginAdd = calls.filter(
      ({ argv, tool }) =>
        tool === 'dsh' && argv.includes('add') && argv.includes('example-bundle@1.0.0'),
    );
    expect(pluginAdd).toHaveLength(1);
    expect(pluginAdd[0]?.ignoreScripts).toBe('true');
  });

  it('emits a complete dry-run JSON plan and leaves DSH_HOME byte-empty', async () => {
    const { env, home } = await fixture();
    const source = await enginePack({ assets: true, mcp: true, plugin: {} });
    expect(await emptyHome(home)).toBe(true);
    const result = run(home, env, ['--json', 'install', source, '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'planned',
      profile: 'engine-pack',
      plan: {
        targetProfile: 'engine-pack',
        rollbackSnapshot: { enabled: true },
        sideEffects: [{ path: 'profiles/engine-pack/cordis.yml' }],
        plugins: [
          expect.objectContaining({
            exactSpec: 'example-bundle@1.0.0',
            integrity: expect.objectContaining({ kind: 'npm-sri' }),
          }),
        ],
      },
    });
    expect(await emptyHome(home)).toBe(true);
  });

  it('does not let --yes replace exact dangerous flags', async () => {
    const buildFixture = await fixture();
    const buildSource = await enginePack({ plugin: { allowBuilds: true } });
    const build = run(buildFixture.home, buildFixture.env, ['install', buildSource, '--yes']);
    expect(build.status).toBe(21);
    expect(build.stderr).toContain('--allow-build');
    expect(await emptyHome(buildFixture.home)).toBe(true);

    const dangerFixture = await fixture();
    const dangerSource = await enginePack({ permissionPreset: 'danger-full-access' });
    const danger = run(dangerFixture.home, dangerFixture.env, ['install', dangerSource, '--yes']);
    expect(danger.status).toBe(21);
    expect(danger.stderr).toContain('--allow-danger-full-access');
    expect(await emptyHome(dangerFixture.home)).toBe(true);

    const unverifiedFixture = await fixture();
    const unverifiedSource = await enginePack({ plugin: { unverified: true } });
    const unverified = run(unverifiedFixture.home, unverifiedFixture.env, [
      'install',
      unverifiedSource,
      '--frozen',
      '--yes',
    ]);
    expect(unverified.status).toBe(20);
    expect(unverified.stderr).toContain('allow-unverified');
    expect(await emptyHome(unverifiedFixture.home)).toBe(true);

    const replaceFixture = await fixture();
    const existing = join(replaceFixture.home, 'profiles', 'engine-pack');
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, 'user-sentinel'), 'must-survive');
    const replaceSource = await enginePack();
    const replace = run(replaceFixture.home, replaceFixture.env, [
      'install',
      replaceSource,
      '--yes',
    ]);
    expect(replace.status).toBe(22);
    expect(replace.stderr).toContain('--replace');
    expect(await readFile(join(existing, 'user-sentinel'), 'utf8')).toBe('must-survive');
  });

  it('runs its own copyable install command successfully, exactly as printed', async () => {
    // The refusal tests above assert that the hint *contains* `--allow-danger-full-access`. That
    // is a claim about a string. `init` shipped a hint that contained exactly the right-looking
    // flag and still did nothing when pasted, and no string assertion could have caught it —
    // only running the thing does. This is the same nail for the command users are most likely to
    // copy, and the one whose flags actually grant permissions.
    //
    // Nothing here names a flag: whatever the tool prints is what gets run.
    const { env, home } = await fixture();
    // Deliberately a path with a space in it. The hint quotes data values, and with every path in
    // this suite being space-free a renderer that stopped quoting entirely would still produce a
    // command that runs — so the quoting would be untested while looking tested.
    const source = join(home, '..', 'source with space');
    await cp(await enginePack({ permissionPreset: 'danger-full-access' }), source, {
      recursive: true,
    });

    const refused = run(home, env, ['--json', 'install', source, '--yes']);
    expect(refused.status).toBe(21);
    expect(await emptyHome(home)).toBe(true);

    const hint = (JSON.parse(refused.stdout).diagnostics as { hint?: string }[]).find(
      ({ hint: text }) => text?.includes('dshpack install'),
    )?.hint;
    expect(hint).toBeDefined();
    const printed = (hint as string).slice((hint as string).indexOf('dshpack install'));

    // The hint quotes data values for PowerShell, whose single-quoted strings have exactly one
    // rule: `''` is a literal quote and nothing else escapes. Decoding that is one substitution,
    // not a re-implementation of a shell parser — the risk of getting it wrong the same way the
    // renderer might is nil.
    const argv = (printed.match(/'(?:[^']|'')*'|\S+/gu) ?? [])
      .slice(1)
      .map((token) => (token.startsWith("'") ? token.slice(1, -1).replaceAll("''", "'") : token));

    const copied = spawnSync(process.execPath, [binPath, ...argv], { encoding: 'utf8', env });

    // Unlike `init`, a successful `install` is not silent — the plan goes to stderr by design, so
    // the pass condition is the exit code plus the profile actually being on disk.
    expect(copied.status).toBe(0);
    expect(copied.stderr).toContain('danger-full-access');
    await expect(access(join(home, 'profiles', 'engine-pack'))).resolves.toBeUndefined();
  });

  it('rejects an unpinned GitHub source before any shim subprocess', async () => {
    const { env, home, log } = await fixture();
    const result = run(home, env, ['--json', 'install', 'github:owner/repo#main', '--yes']);
    expect(result.status).toBe(20);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'SOURCE_INVALID' })],
      status: 'not-started',
    });
    expect(await emptyHome(home)).toBe(true);
    await expect(access(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
