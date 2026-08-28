import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { SourceError } from '../src/adapters/source.js';
import { installPack } from '../src/install/engine.js';
import { inspectMetadata } from '../src/list/contracts.js';
import { listProfiles } from '../src/list/engine.js';
import { enginePack, fakeRuntime, snapshot } from './install-engine-fixture.js';

const roots: string[] = [];
async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-engine-home-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('install ten-stage engine', () => {
  it('persists composed provenance in a v1 marker and projects the same public records', async () => {
    const dshHome = await home();
    const provenance = [
      {
        id: 'fixture-notes',
        from: 'github:example/fixture-skills#0123456789abcdef0123456789abcdef01234567',
        originalId: 'notes',
        license: 'MIT',
      },
    ];
    const installed = await installPack(
      {
        source: await enginePack({ provenance }),
        dshHome,
        frozen: true,
        yes: true,
        interactive: false,
      },
      fakeRuntime().runtime,
    );

    expect(installed.exitCode).toBe(0);
    const marker = JSON.parse(
      await readFile(join(dshHome, '.dshpack', 'installed', 'engine-pack.json'), 'utf8'),
    ) as unknown;
    expect(marker).toMatchObject({ metadataVersion: 1, provenance });
    const listed = await listProfiles({ dshHome });
    expect(listed.exitCode).toBe(0);
    expect(listed.metadata.profiles).toContainEqual(
      expect.objectContaining({
        profile: 'engine-pack',
        status: 'tracked',
        packDetails: expect.objectContaining({ provenance }),
      }),
    );
  });

  it('keeps skipped archive-entry diagnostics visible in an install plan', async () => {
    const dshHome = await home();
    const source = await enginePack();
    const fake = fakeRuntime();
    const baseMaterialize = fake.runtime.materializeSource;
    fake.runtime.materializeSource = async (reference) => ({
      ...(await baseMaterialize(reference)),
      diagnostics: [
        {
          code: 'E_ARCHIVE_ENTRY_SKIPPED',
          severity: 'warning',
          message: 'Skipped non-regular archive entry: skills/link.',
          hint: 'The entry was not deployed or followed.',
          evidence: 'local',
        },
      ],
    });

    const report = await installPack(
      { source, dshHome, dryRun: true, json: true, interactive: false },
      fake.runtime,
    );

    expect(report).toMatchObject({
      exitCode: 0,
      diagnostics: [
        expect.objectContaining({ code: 'E_ARCHIVE_ENTRY_SKIPPED', severity: 'warning' }),
      ],
    });
  });

  it('stops dry-run at the plan, cleans source, and leaves DSH_HOME byte-identical', async () => {
    const dshHome = await home();
    await writeFile(join(dshHome, 'sentinel'), 'unchanged');
    const source = await enginePack({
      assets: true,
      mcp: true,
      permissionPreset: 'danger-full-access',
      plugin: { allowBuilds: true },
    });
    const before = await snapshot(dshHome);
    const fake = fakeRuntime();
    const report = await installPack(
      { source, dshHome, dryRun: true, json: true, interactive: false },
      fake.runtime,
    );
    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'planned' } });
    expect(report.metadata.plan?.writes).toEqual(expect.any(Array));
    expect(fake.stderr).toEqual([]);
    expect(await snapshot(dshHome)).toEqual(before);
    expect(fake.calls).toContain('cleanup:source');
    expect(fake.calls).not.toContainEqual(expect.stringMatching(/^dsh:/u));
    const reviewHome = await home();
    const review = fakeRuntime();
    const human = await installPack(
      { source, dshHome: reviewHome, dryRun: true, interactive: false },
      review.runtime,
    );
    expect(human.exitCode).toBe(0);
    const plan = human.metadata.plan as NonNullable<typeof human.metadata.plan>;
    const text = review.stderr.join('\n');
    expect(text).toContain('Will install engine-pack@1.0.0');
    expect(text).toContain(`dsh: current=${plan.dsh.current} tested=${plan.dsh.tested.join(',')}`);
    expect(text).toContain(`plugin example-bundle: example-bundle@1.0.0`);
    expect(text).toContain(JSON.stringify(plan.plugins[0]?.integrity));
    expect(text).toContain(`\u001b[31m[危险 allowBuilds] example-bundle\u001b[0m`);
    for (const asset of [...plan.skills, ...plan.presets]) {
      expect(text).toContain(`${asset.source} -> ${asset.target}`);
      expect(text).toContain(`[${asset.effectiveAt}]`);
    }
    expect(text).toContain(`MCP docs: https://mcp.example/docs`);
    expect(text).toContain(`[${plan.mcp[0]?.effectiveAt}]`);
    expect(text).toContain(`settings settings/agent-presets.yml -> settings.yaml#agent-presets`);
    expect(text).toContain(`default agentPreset=custom source=pack`);
    expect(text).toContain(`default permissionPreset=danger-full-access`);
    expect(text).toContain(`\u001b[31m[危险 permission] danger-full-access`);
    for (const write of plan.writes)
      expect(text).toContain(`write ${write.path} [${write.effectiveAt}]`);
    expect(text).toContain('side-effect profiles/engine-pack/cordis.yml');
    expect(text).toContain(
      `rollback snapshot: enabled=true state=${plan.rollbackSnapshot.targetBeforeStateDigest}`,
    );
    expect(review.calls).not.toContainEqual(expect.stringMatching(/^confirm:|^dsh:/u));
  });
  it('installs an empty-plugin pack, discloses E9, and writes valid tracked metadata', async () => {
    const dshHome = await home();
    const source = await enginePack();
    const fake = fakeRuntime();
    const report = await installPack(
      { source, dshHome, yes: true, interactive: false },
      fake.runtime,
    );
    expect(report).toMatchObject({ exitCode: 0, metadata: { status: 'installed' } });
    expect(fake.calls).toContain('stage:init');
    expect(fake.calls).toContain('stage:dump');
    expect(fake.calls).toContain('stage:doctor');
    expect(fake.calls).toContain('stage:metadata');
    expect(await inspectMetadata(dshHome, 'engine-pack')).toMatchObject({ status: 'valid' });
    expect(await readFile(join(dshHome, 'profiles', 'engine-pack', 'cordis.yml'), 'utf8')).toBe(
      '[]\n',
    );
  });
  it('skips existing assets by default and force replaces them through journaled backups', async () => {
    const source = await enginePack({ assets: true });
    const skipHome = await home();
    await mkdir(join(skipHome, 'skills', 'notes'), { recursive: true });
    await writeFile(join(skipHome, 'skills', 'notes', 'old'), 'user-owned');
    const skipped = await installPack(
      { source, dshHome: skipHome, yes: true, interactive: false },
      fakeRuntime().runtime,
    );
    expect(skipped.exitCode).toBe(0);
    expect(await readFile(join(skipHome, 'skills', 'notes', 'old'), 'utf8')).toBe('user-owned');
    expect(skipped.diagnostics).toContainEqual(expect.objectContaining({ code: 'W_ASSET_EXISTS' }));
    const forceHome = await home();
    await mkdir(join(forceHome, 'skills', 'notes'), { recursive: true });
    await mkdir(join(forceHome, '.agent-presets', 'custom'), { recursive: true });
    await writeFile(join(forceHome, 'skills', 'notes', 'old'), 'old-skill');
    await writeFile(join(forceHome, '.agent-presets', 'custom', 'old'), 'old-preset');
    const forced = await installPack(
      { source, dshHome: forceHome, yes: true, force: true, interactive: false },
      fakeRuntime().runtime,
    );
    expect(forced.exitCode).toBe(0);
    expect(await readFile(join(forceHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain(
      'fixture notes',
    );
    expect(
      await readFile(join(forceHome, '.agent-presets', 'custom', 'agent.cordis.yml'), 'utf8'),
    ).toBe('[]\n');
    const backup = await snapshot(forced.metadata.backupDirectory as string);
    expect(Object.values(backup)).toContain(Buffer.from('old-skill').toString('base64'));
    expect(Object.values(backup)).toContain(Buffer.from('old-preset').toString('base64'));
  });

  it('merges settings and restores its original bytes when a later doctor stage fails', async () => {
    const dshHome = await home();
    const original = '# user comment\nother:\n  keep: true\nagent-presets:\n  old: value\n';
    await writeFile(join(dshHome, 'settings.yaml'), original);
    const source = await enginePack({ assets: true });
    const fake = fakeRuntime({ fault: 'doctor' });

    const report = await installPack(
      { source, dshHome, yes: true, interactive: false },
      fake.runtime,
    );

    expect(report).toMatchObject({ exitCode: 24, metadata: { status: 'rolled-back' } });
    expect(await readFile(join(dshHome, 'settings.yaml'), 'utf8')).toBe(original);
    await expect(
      readFile(join(dshHome, 'profiles', 'engine-pack', 'package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires a second exact authorization for transitive build scripts', async () => {
    const source = await enginePack();
    const declinedHome = await home();
    const declined = await installPack(
      { source, dshHome: declinedHome, yes: true, interactive: false },
      fakeRuntime({ transitive: ['transitive-build'] }).runtime,
    );
    expect(declined.exitCode).toBe(21);
    expect(declined.diagnostics[0]?.hint).toContain('--allow-build');
    expect(declined.diagnostics[0]?.hint).toContain('transitive-build');
    await expect(
      readFile(join(declinedHome, 'profiles', 'engine-pack', 'package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const allowedHome = await home();
    const fake = fakeRuntime({ transitive: ['transitive-build'] });
    const allowed = await installPack(
      {
        source,
        dshHome: allowedHome,
        yes: true,
        allowBuilds: ['transitive-build'],
        interactive: false,
      },
      fake.runtime,
    );
    expect(allowed.exitCode).toBe(0);
    expect(fake.calls).toContain('pnpm:rebuild transitive-build');
    expect(fake.scriptPolicies).toContainEqual({
      command: 'pnpm',
      policy: 'allow-approved',
    });
  });

  it('returns a complete safe replay argv for a newly discovered transitive build', async () => {
    const realSource = await enginePack({
      permissionPreset: 'danger-full-access',
      plugin: { unverified: true },
    });
    const hostileSource = "--bad;Write-Output PWNED $(Get-ChildItem) %PATH% it's";
    const dshHome = await home();
    await mkdir(join(dshHome, 'profiles', 'replay-profile'), { recursive: true });
    await writeFile(join(dshHome, 'profiles', 'replay-profile', 'old'), 'replace-me');
    const fake = fakeRuntime({ transitive: ['transitive-build'] });
    fake.runtime.materializeSource = async (reference) => ({
      directory: realSource,
      provenance: { kind: 'directory', path: reference },
      async cleanup() {
        fake.calls.push('cleanup:source');
      },
    });
    fake.runtime.probe = async () => ({ dshVersion: '9.9.9', pnpmVersion: '11.7.0' });

    const report = await installPack(
      {
        source: hostileSource,
        dshHome,
        as: 'replay-profile',
        replace: true,
        frozen: true,
        force: true,
        yes: true,
        allowUnverified: true,
        allowDangerFullAccess: true,
        allowVersionMismatch: true,
        interactive: false,
      },
      fake.runtime,
    );

    expect(report).toMatchObject({ exitCode: 21, metadata: { status: 'rolled-back' } });
    expect(report.metadata.requiredCommand?.argv).toEqual([
      'install',
      '--as',
      'replay-profile',
      '--dsh-home',
      dshHome,
      '--frozen',
      '--replace',
      '--allow-unverified',
      '--allow-build',
      'transitive-build',
      '--allow-danger-full-access',
      '--allow-version-mismatch',
      '--force',
      '--yes',
      '--',
      hostileSource,
    ]);
    expect(report.metadata.requiredCommand?.powerShell).toContain(
      `-- '${hostileSource.replaceAll("'", "''")}'`,
    );
    expect(report.diagnostics.find(({ code }) => code === 'E_BUILD_TRANSITIVE')?.hint).toContain(
      report.metadata.requiredCommand?.powerShell,
    );
  });

  it('never lets --yes replace direct build, danger, unverified, or replace authorization', async () => {
    const directSource = await enginePack({ plugin: { allowBuilds: true } });
    const directHome = await home();
    const direct = await installPack(
      { source: directSource, dshHome: directHome, yes: true, interactive: false },
      fakeRuntime().runtime,
    );
    expect(direct).toMatchObject({ exitCode: 21, metadata: { status: 'not-started' } });
    expect(direct.diagnostics[0]?.hint).toContain('--allow-build');

    const dangerSource = await enginePack({ permissionPreset: 'danger-full-access' });
    const danger = await installPack(
      { source: dangerSource, dshHome: await home(), yes: true, interactive: false },
      fakeRuntime().runtime,
    );
    expect(danger.exitCode).toBe(21);

    const unverifiedSource = await enginePack({ plugin: { unverified: true } });
    const unverified = await installPack(
      {
        source: unverifiedSource,
        dshHome: await home(),
        frozen: true,
        yes: true,
        interactive: false,
      },
      fakeRuntime().runtime,
    );
    expect(unverified.exitCode).toBe(20);

    const replaceHome = await home();
    await mkdir(join(replaceHome, 'profiles', 'engine-pack'), { recursive: true });
    await writeFile(join(replaceHome, 'profiles', 'engine-pack', 'sentinel'), 'old');
    const replace = await installPack(
      { source: await enginePack(), dshHome: replaceHome, yes: true, interactive: false },
      fakeRuntime().runtime,
    );
    expect(replace.exitCode).toBe(22);
    expect(await readFile(join(replaceHome, 'profiles', 'engine-pack', 'sentinel'), 'utf8')).toBe(
      'old',
    );
  });

  it('accepts each explicit permission independently and installs a direct plugin once', async () => {
    const directSource = await enginePack({ plugin: { allowBuilds: true } });
    const directFake = fakeRuntime();
    const direct = await installPack(
      {
        source: directSource,
        dshHome: await home(),
        yes: true,
        allowBuilds: ['example-bundle'],
        interactive: false,
      },
      directFake.runtime,
    );
    expect(direct.exitCode).toBe(0);
    expect(directFake.calls).toContain('allow-build:example-bundle');
    expect(
      directFake.calls.filter(
        (call) => call === 'dsh:plugin --profile engine-pack add example-bundle@1.0.0',
      ),
    ).toHaveLength(1);
    expect(directFake.scriptPolicies).toContainEqual({ command: 'dsh', policy: 'deny' });

    const danger = await installPack(
      {
        source: await enginePack({ permissionPreset: 'danger-full-access' }),
        dshHome: await home(),
        yes: true,
        allowDangerFullAccess: true,
        interactive: false,
      },
      fakeRuntime().runtime,
    );
    expect(danger.exitCode).toBe(0);

    const unverified = await installPack(
      {
        source: await enginePack({ plugin: { unverified: true } }),
        dshHome: await home(),
        yes: true,
        allowUnverified: true,
        interactive: false,
      },
      fakeRuntime().runtime,
    );
    expect(unverified.exitCode).toBe(0);
  });

  it('installs only captured bytes when SOURCE is deleted after confirmation', async () => {
    const source = await enginePack({ assets: true });
    const dshHome = await home();
    const fake = fakeRuntime({
      confirmations: [true],
      onConfirm: async () => rm(source, { recursive: true, force: true }),
    });
    const report = await installPack({ source, dshHome, interactive: true }, fake.runtime);
    expect(report.exitCode).toBe(0);
    expect(await readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toContain(
      'fixture notes',
    );
  });

  it('rejects target state drift after confirmation before creating a profile', async () => {
    const dshHome = await home();
    const fake = fakeRuntime({
      confirmations: [true],
      onConfirm: async () => writeFile(join(dshHome, 'settings.yaml'), 'concurrent: true\n'),
    });
    const report = await installPack(
      { source: await enginePack(), dshHome, interactive: true },
      fake.runtime,
    );
    expect(report).toMatchObject({ exitCode: 30, metadata: { status: 'not-started' } });
    await expect(
      readFile(join(dshHome, 'profiles', 'engine-pack', 'package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses exact reviewed settings bytes and does not overwrite a concurrent writer', async () => {
    const dshHome = await home();
    await writeFile(join(dshHome, 'settings.yaml'), 'original: true\n');
    const concurrent = 'concurrent: preserved\n';
    const report = await installPack(
      { source: await enginePack({ assets: true }), dshHome, yes: true, interactive: false },
      fakeRuntime({ settingsCasMutation: concurrent }).runtime,
    );
    expect(report).toMatchObject({ exitCode: 30, metadata: { status: 'rolled-back' } });
    expect(await readFile(join(dshHome, 'settings.yaml'), 'utf8')).toBe(concurrent);
    await expect(readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves typed source security errors and cleans every acquired source exactly once', async () => {
    const dshHome = await home();
    const source = await enginePack();
    const archive = fakeRuntime();
    archive.runtime.materializeSource = async () => {
      throw new SourceError('SOURCE_ARCHIVE_ENTRY', 31, 'tar-slip entry rejected');
    };
    const rejected = await installPack(
      { source, dshHome, dryRun: true, interactive: false },
      archive.runtime,
    );
    expect(rejected).toMatchObject({ exitCode: 31 });
    expect(rejected.diagnostics[0]).toMatchObject({ code: 'SOURCE_ARCHIVE_ENTRY' });

    for (const setup of [() => fakeRuntime(), () => fakeRuntime({ fault: 'source-cleanup' })]) {
      const fake = setup();
      await installPack(
        { source, dshHome: await home(), dryRun: true, interactive: false },
        fake.runtime,
      );
      expect(fake.calls.filter((call) => call === 'cleanup:source')).toHaveLength(1);
    }
  });
});
