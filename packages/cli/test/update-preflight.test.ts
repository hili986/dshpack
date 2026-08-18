import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { materializeSource, SourceError, type SourceProvenance } from '../src/adapters/source.js';
import { writeReport } from '../src/commands/shared.js';
import { EXIT_CODES } from '../src/exit-codes.js';
import { installPack } from '../src/install/engine.js';
import { preflightUpdate, updateProfile } from '../src/update/engine.js';
import { decideUpdateAuthorization } from '../src/update/policy.js';
import { type EnginePackOptions, enginePack, fakeRuntime } from './install-engine-fixture.js';

const homes = new Set<string>();

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dshpack-update-home-'));
  homes.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...homes].map((directory) => rm(directory, { recursive: true, force: true })));
  homes.clear();
});

async function installedProfile(options: Parameters<typeof enginePack>[0] = {}) {
  const dshHome = await home();
  const source = await enginePack(options);
  const fixture = fakeRuntime();
  const installed = await installPack(
    {
      source,
      dshHome,
      interactive: false,
      frozen: true,
      yes: true,
    },
    fixture.runtime,
  );
  expect(installed.exitCode).toBe(EXIT_CODES.SUCCESS);
  return { dshHome, fixture, profile: options.name ?? 'engine-pack' };
}

describe('update preflight', () => {
  it('rejects mutually exclusive conflict strategies before reading the marker', async () => {
    const current = await installedProfile();
    const materialize = vi.spyOn(current.fixture.runtime, 'materializeSource');

    const result = await preflightUpdate(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        ours: true,
        theirs: true,
        interactive: false,
      },
      current.fixture.runtime,
    );

    expect(result.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_UPDATE_STRATEGY' }),
    ]);
    expect(materialize).not.toHaveBeenCalled();
  });

  it('returns an untracked marker diagnostic before materializing a target', async () => {
    const dshHome = await home();
    const fixture = fakeRuntime();
    const materialize = vi.spyOn(fixture.runtime, 'materializeSource');

    const result = await preflightUpdate(
      { dshHome, profile: 'engine-pack', interactive: false },
      fixture.runtime,
    );

    expect(result.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_UPDATE_MARKER_UNTRACKED' }),
    ]);
    expect(materialize).not.toHaveBeenCalled();
  });

  it('preserves contract and security marker-read classifications without materializing a source', async () => {
    const malformed = await installedProfile();
    const malformedMaterialize = vi.spyOn(malformed.fixture.runtime, 'materializeSource');
    await writeFile(
      join(malformed.dshHome, '.dshpack', 'installed', `${malformed.profile}.json`),
      '{ not valid JSON',
    );
    const malformedResult = await preflightUpdate(
      { dshHome: malformed.dshHome, profile: malformed.profile, interactive: false },
      malformed.fixture.runtime,
    );
    expect(malformedResult.report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(malformedResult.report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_MARKER' })]),
    );
    expect(malformedMaterialize).not.toHaveBeenCalled();

    const linked = await installedProfile();
    const installed = join(linked.dshHome, '.dshpack', 'installed');
    const outside = join(linked.dshHome, 'marker-target');
    await mkdir(outside);
    await rm(installed, { recursive: true, force: true });
    await symlink(outside, installed, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedResult = await preflightUpdate(
      { dshHome: linked.dshHome, profile: linked.profile, interactive: false },
      linked.fixture.runtime,
    );
    expect(linkedResult.report.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(linkedResult.report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UPDATE_MARKER' })]),
    );
  });

  it('maps generic SOURCE, target-read, probe, pnpm, and resolver failures without applying', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile });

    const sourceFailure = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      {
        ...current.fixture.runtime,
        materializeSource: async () => Promise.reject(new Error('offline')),
      },
    );
    expect(sourceFailure.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_SOURCE' }),
    ]);

    const readFailure = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      {
        ...current.fixture.runtime,
        readValidatedPack: async () => ({ diagnostics: [], exitCode: EXIT_CODES.CONTRACT }),
      },
    );
    expect(readFailure.report.exitCode).toBe(EXIT_CODES.CONTRACT);

    const probeFailure = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      { ...current.fixture.runtime, probe: async () => Promise.reject(new Error('missing')) },
    );
    expect(probeFailure.report.diagnostics).toEqual([expect.objectContaining({ code: 'E_PROBE' })]);

    const pnpmFailure = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      {
        ...current.fixture.runtime,
        probe: async () => ({ dshVersion: '0.1.0-rc.6', pnpmVersion: '9.0.0' }),
      },
    );
    expect(pnpmFailure.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_PNPM_VERSION_UNSUPPORTED' }),
    ]);

    const resolverFailure = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      {
        ...current.fixture.runtime,
        resolvePlugins: async () => Promise.reject(new Error('resolver')),
      },
    );
    expect(resolverFailure.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_PLUGIN_RESOLUTION' }),
    ]);

    const sourceResolverFailure = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      {
        ...current.fixture.runtime,
        resolvePlugins: async () =>
          Promise.reject(new SourceError('SOURCE_RESOLUTION', EXIT_CODES.SECURITY, 'fixture')),
      },
    );
    expect(sourceResolverFailure.report.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(sourceResolverFailure.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'SOURCE_RESOLUTION' }),
    ]);
  });

  it('preserves generic and SOURCE read errors, including cleanup failure, before probe', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile });
    const materialize = current.fixture.runtime.materializeSource.bind(current.fixture.runtime);
    const generic = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      {
        ...current.fixture.runtime,
        readValidatedPack: async () => Promise.reject(new Error('broken read')),
      },
    );
    expect(generic.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_SOURCE_READ' }),
    ]);

    const cleanup = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      {
        ...current.fixture.runtime,
        materializeSource: async (reference) => {
          const source = await materialize(reference);
          return { ...source, cleanup: async () => Promise.reject(new Error('cleanup')) };
        },
        readValidatedPack: async () =>
          Promise.reject(new SourceError('SOURCE_READ', 20, 'fixture')),
      },
    );
    expect(cleanup.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'SOURCE_READ' }),
      expect.objectContaining({ code: 'E_SOURCE_CLEANUP' }),
    ]);

    const missingReadFields = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      {
        ...current.fixture.runtime,
        readValidatedPack: async () => ({ diagnostics: [], exitCode: EXIT_CODES.CONTRACT }),
      },
    );
    expect(missingReadFields.report.exitCode).toBe(EXIT_CODES.CONTRACT);
  });

  it('reports an update dry run without entering apply', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile });
    const callsBefore = current.fixture.calls.length;

    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        dryRun: true,
        interactive: false,
      },
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(result.metadata.status).toBe('preflight');
    expect(
      current.fixture.calls.slice(callsBefore).filter((call) => call.startsWith('stage:')),
    ).toEqual([]);
  });

  it('emits safe source, integrity, and every authorization delta for human dry-run and rejection review', async () => {
    const current = await installedProfile();
    const target = await enginePack({
      name: current.profile,
      plugin: { allowBuilds: true },
      permissionPreset: 'danger-full-access',
      tested: ['9.9.9'],
    });
    const dryRun = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        dryRun: true,
        interactive: false,
      },
      current.fixture.runtime,
    );
    expect(dryRun.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(dryRun.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'I_UPDATE_SOURCE', severity: 'info' }),
        expect.objectContaining({ code: 'I_UPDATE_INTEGRITY', severity: 'info' }),
      ]),
    );
    expect(
      dryRun.diagnostics.filter((item) => item.code === 'I_UPDATE_AUTHORIZATION'),
    ).toHaveLength(4);
    expect(JSON.stringify(dryRun)).not.toContain('\u0000');
    expect(JSON.stringify(dryRun)).not.toContain('example-bundle-package-json');

    const rejected = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        yes: true,
        interactive: false,
      },
      current.fixture.runtime,
    );
    expect(rejected.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(
      rejected.diagnostics.filter((item) => item.code === 'I_UPDATE_AUTHORIZATION'),
    ).toHaveLength(4);
  });

  it.each([
    [
      'GitHub',
      {
        kind: 'github',
        owner: 'dsh-packs',
        repo: 'example',
        commit: '0123456789abcdef0123456789abcdef01234567',
        url: 'https://github.invalid/dsh-packs/example/archive.tar.gz',
      },
    ],
    [
      'HTTPS archive',
      { kind: 'https', url: 'https://packs.invalid/pack.tgz', integrity: 'sha512-ok' },
    ],
    ['local archive', { kind: 'archive', path: '/safe/pack.dshpack.tgz' }],
  ] as const)(
    'renders a safe %s source review during dry-run',
    async (_label, provenance: SourceProvenance) => {
      const current = await installedProfile();
      const target = await enginePack({ name: current.profile });
      const result = await updateProfile(
        {
          dshHome: current.dshHome,
          profile: current.profile,
          to: target,
          dryRun: true,
          interactive: false,
        },
        {
          ...current.fixture.runtime,
          async materializeSource() {
            return { directory: target, provenance, cleanup: async () => undefined };
          },
        },
      );

      expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'I_UPDATE_SOURCE' })]),
      );
      expect(JSON.stringify(result.diagnostics)).not.toContain('github.invalid');
    },
  );

  it('keeps dry-run authorization as review-only without treating dangerous deltas as approved', () => {
    expect(
      decideUpdateAuthorization({ dryRun: true, interactive: false }, [
        { kind: 'danger-full-access' },
      ]),
    ).toEqual({ status: 'review-only', missing: [], normalConfirmationRequired: false });
  });

  it('uses the persisted source when --to is omitted and renders omitted optional flags safely', async () => {
    const current = await installedProfile();
    const materialize = vi.spyOn(current.fixture.runtime, 'materializeSource');

    const result = await updateProfile(
      { dshHome: current.dshHome, profile: current.profile, interactive: false },
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(materialize).toHaveBeenCalledTimes(1);
    const confirmation = result.diagnostics.find((item) => item.code === 'E_CONFIRMATION_REQUIRED');
    expect(confirmation?.hint).not.toContain('--to');
    expect(confirmation?.hint).not.toContain('--dry-run');
    expect(confirmation?.hint).not.toContain('--ours');
    expect(confirmation?.hint).not.toContain('--theirs');
    expect(confirmation?.hint).not.toContain('--json');
  });

  it.each([
    ['danger-full-access', { permissionPreset: 'danger-full-access' as const }],
    ['version mismatch', { tested: ['9.9.9'] }],
  ])(
    'prompts and applies an interactive %s authorization only after acceptance',
    async (_label, targetOptions) => {
      const current = await installedProfile();
      const target = await enginePack({ ...targetOptions, name: current.profile });
      const runtime = fakeRuntime({ confirmations: [true] });

      const result = await updateProfile(
        {
          dshHome: current.dshHome,
          profile: current.profile,
          to: target,
          interactive: true,
          yes: true,
        },
        runtime.runtime,
      );

      expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
      expect(runtime.calls.filter((call) => call.startsWith('confirm:'))).toHaveLength(1);
    },
  );

  it('reads the tracked v1 marker, materializes and validates the target, probes and resolves', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile });
    const materializeSource = vi.spyOn(current.fixture.runtime, 'materializeSource');
    const readValidatedPack = vi.spyOn(current.fixture.runtime, 'readValidatedPack');
    const probe = vi.spyOn(current.fixture.runtime, 'probe');
    const resolvePlugins = vi.spyOn(current.fixture.runtime, 'resolvePlugins');

    const result = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      current.fixture.runtime,
    );

    expect(result.report.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(result.preflight?.marker.metadata.metadataVersion).toBe(1);
    expect(result.preflight?.source).toMatchObject({ kind: 'directory', path: target });
    expect(materializeSource).toHaveBeenCalledWith(target);
    expect(readValidatedPack).toHaveBeenCalledWith(target, { frozen: true });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(resolvePlugins).toHaveBeenCalledTimes(1);
    expect(current.fixture.calls).toContain('cleanup:source');
  });

  it('reuses a persisted GitHub provenance as a fixed SHA source reference', async () => {
    const current = await installedProfile();
    const materializeSource = vi
      .spyOn(current.fixture.runtime, 'materializeSource')
      .mockRejectedValueOnce(new SourceError('SOURCE_NETWORK', 20, 'blocked'));
    const callsBefore = current.fixture.calls.length;
    const marker = await import('../src/restore/engine.js').then(({ readMarker }) =>
      readMarker(current.dshHome, current.profile),
    );
    expect(marker.marker).toBeDefined();
    const document = JSON.parse(marker.marker?.document ?? '{}') as Record<string, unknown>;
    document.source = {
      kind: 'github',
      owner: 'dsh-packs',
      repo: 'example',
      commit: '0123456789abcdef0123456789abcdef01234567',
      url: 'https://codeload.github.com/dsh-packs/example/tar.gz/0123456789abcdef0123456789abcdef01234567',
    };
    // `readMarker` owns the secure read. Re-installing a valid marker is intentionally avoided;
    // this seam proves update passes a persisted reference through the runtime source boundary.
    await current.fixture.runtime.atomicWriteText(
      join(current.dshHome, '.dshpack', 'installed', `${current.profile}.json`),
      `${JSON.stringify(document)}\n`,
    );

    const result = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, interactive: false },
      current.fixture.runtime,
    );

    expect(materializeSource).toHaveBeenCalledWith(
      'github:dsh-packs/example#0123456789abcdef0123456789abcdef01234567',
    );
    expect(result.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'SOURCE_NETWORK', message: 'SOURCE 获取或校验失败。' }),
    ]);
    expect(current.fixture.calls.slice(callsBefore)).not.toContain('probe');
  });

  it('blocks a source error before target resolution or any target write', async () => {
    const current = await installedProfile();
    const source = vi
      .spyOn(current.fixture.runtime, 'materializeSource')
      .mockRejectedValueOnce(new SourceError('SOURCE_INVALID', 20, 'must be exact'));
    const read = vi.spyOn(current.fixture.runtime, 'readValidatedPack');
    const callsBefore = current.fixture.calls.length;

    const result = await preflightUpdate(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: 'github:owner/repo#MAIN',
        interactive: false,
      },
      current.fixture.runtime,
    );

    expect(source).toHaveBeenCalledWith('github:owner/repo#MAIN');
    expect(read).not.toHaveBeenCalled();
    expect(result.report.exitCode).toBe(EXIT_CODES.SOURCE_NETWORK_INTEGRITY);
    expect(result.report.diagnostics[0]).toMatchObject({ code: 'SOURCE_INVALID' });
    expect(
      current.fixture.calls.slice(callsBefore).filter((call) => call.startsWith('stage:')),
    ).toEqual([]);
  });

  it('preserves a primary SECURITY read failure when private source cleanup also fails', async () => {
    const current = await installedProfile();
    const materialize = current.fixture.runtime.materializeSource.bind(current.fixture.runtime);
    const primary = {
      code: 'E_SECRET_TEST',
      severity: 'error' as const,
      message: 'validated source contains a secret',
      hint: 'remove the secret',
      evidence: 'local' as const,
    };
    const runtime = {
      ...current.fixture.runtime,
      materializeSource: async (reference: string) => {
        const source = await materialize(reference);
        return { ...source, cleanup: async () => Promise.reject(new Error('cleanup failed')) };
      },
      readValidatedPack: async () => ({ diagnostics: [primary], exitCode: EXIT_CODES.SECURITY }),
    };

    const result = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: 'target', interactive: false },
      runtime,
    );

    expect(result.report.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(result.report.diagnostics.map((item) => item.code)).toEqual([
      'E_SECRET_TEST',
      'E_SOURCE_CLEANUP',
    ]);
  });

  it('reports E_SOURCE_CLEANUP with source exit 20 when cleanup is the only failure', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile });
    const materialize = current.fixture.runtime.materializeSource.bind(current.fixture.runtime);
    const runtime = {
      ...current.fixture.runtime,
      materializeSource: async (reference: string) => {
        const source = await materialize(reference);
        return { ...source, cleanup: async () => Promise.reject(new Error('cleanup failed')) };
      },
    };

    const result = await preflightUpdate(
      { dshHome: current.dshHome, profile: current.profile, to: target, interactive: false },
      runtime,
    );

    expect(result.preflight).toBeUndefined();
    expect(result.report.exitCode).toBe(EXIT_CODES.SOURCE_NETWORK_INTEGRITY);
    expect(result.report.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_SOURCE_CLEANUP' }),
    ]);
  });

  it.each(['../outside', 'profile\\escape'])(
    'rejects an unsafe profile segment before marker or source access: %s',
    async (profile) => {
      const current = await installedProfile();
      const materializeSource = vi.spyOn(current.fixture.runtime, 'materializeSource');
      const readValidatedPack = vi.spyOn(current.fixture.runtime, 'readValidatedPack');

      const result = await preflightUpdate(
        {
          dshHome: current.dshHome,
          profile,
          to: 'github:dsh-packs/example#0123456789abcdef0123456789abcdef01234567',
          interactive: false,
        },
        current.fixture.runtime,
      );

      expect(result.report.diagnostics).toEqual([
        expect.objectContaining({ code: 'E_UPDATE_PROFILE' }),
      ]);
      expect(materializeSource).not.toHaveBeenCalled();
      expect(readValidatedPack).not.toHaveBeenCalled();
    },
  );

  it('never serializes an invalid profile through updateProfile JSON reporting', async () => {
    const current = await installedProfile();
    const secretProfile = '../secret-like-value';
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    const report = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: secretProfile,
        interactive: false,
        json: true,
      },
      current.fixture.runtime,
    );
    writeReport(report, true);

    expect(report.diagnostics).toEqual([expect.objectContaining({ code: 'E_UPDATE_PROFILE' })]);
    expect(JSON.stringify(report)).not.toContain('secret-like-value');
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).not.toContain('secret-like-value');
  });

  it('keeps the existing GitHub SHA and HTTPS SRI source validation in the update source chain', async () => {
    const current = await installedProfile();
    const read = vi.spyOn(current.fixture.runtime, 'readValidatedPack');
    const runtime = {
      ...current.fixture.runtime,
      materializeSource: (reference: string) =>
        materializeSource(reference, {
          resolveHostname: async () => [{ address: '8.8.8.8', family: 4 as const }],
          download: async () => ({ statusCode: 500 }),
        }),
    };
    const canonicalSri = `sha512-${'A'.repeat(86)}==`;
    const acceptedGithub = await preflightUpdate(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: 'github:dsh-packs/example#0123456789abcdef0123456789abcdef01234567',
        interactive: false,
      },
      runtime,
    );
    expect(acceptedGithub.report.diagnostics[0]).toMatchObject({ code: 'SOURCE_NETWORK' });

    for (const invalid of [
      'github:dsh-packs/example#0123456789ABCDEF0123456789abcdef01234567',
      `http://packs.example/pack.dshpack.tgz#${canonicalSri}`,
      `https://user@packs.example/pack.dshpack.tgz#${canonicalSri}`,
      'https://packs.example/pack.dshpack.tgz#sha512-short',
    ]) {
      const result = await preflightUpdate(
        { dshHome: current.dshHome, profile: current.profile, to: invalid, interactive: false },
        runtime,
      );
      expect(result.report.diagnostics[0]).toMatchObject({ code: 'SOURCE_INVALID' });
      expect(JSON.stringify(result.report.diagnostics)).not.toContain(invalid);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('hard-rejects unverified target resolution until --allow-unverified is explicit', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile });
    const resolvePlugins = vi.spyOn(current.fixture.runtime, 'resolvePlugins').mockResolvedValue({
      mode: 'frozen',
      resolutionDigest: 'sha256-fixture',
      plugins: [
        {
          name: 'example-bundle',
          resolved: { version: '1.0.0' },
          integrity: { kind: 'unverified', reason: 'fixture' },
        },
      ],
    });

    const denied = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: true,
        yes: true,
      },
      current.fixture.runtime,
    );
    expect(denied.exitCode).toBe(EXIT_CODES.SOURCE_NETWORK_INTEGRITY);
    expect(denied.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_UNVERIFIED_REQUIRED' })]),
    );
    expect(current.fixture.calls.filter((call) => call.startsWith('confirm:'))).toEqual([]);

    const allowed = await preflightUpdate(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: false,
        allowUnverified: true,
      },
      current.fixture.runtime,
    );
    expect(resolvePlugins).toHaveBeenCalledTimes(2);
    expect(allowed.report.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(allowed.preflight).toBeDefined();
  });

  it.each([
    ['new plugin identity', {}, { plugin: { allowBuilds: false } }, 'new-plugin'],
    [
      'new allowBuilds on an installed plugin',
      { plugin: { allowBuilds: false } },
      { plugin: { allowBuilds: true } },
      'allow-build',
    ],
    [
      'new danger-full-access',
      {},
      { permissionPreset: 'danger-full-access' },
      'danger-full-access',
    ],
    ['target dsh tested mismatch', {}, { tested: ['9.9.9'] }, 'version-mismatch'],
  ] as const satisfies readonly [
    string,
    EnginePackOptions,
    EnginePackOptions,
    'new-plugin' | 'allow-build' | 'danger-full-access' | 'version-mismatch',
  ][])(
    'does not let --yes bypass %s authorization',
    async (_label, currentOptions, targetOptions, kind) => {
      const current = await installedProfile(currentOptions);
      const targetTested = 'tested' in targetOptions ? targetOptions.tested : undefined;
      const target = await enginePack({
        ...targetOptions,
        ...(targetTested === undefined ? {} : { tested: [...targetTested] }),
        name: current.profile,
      });
      const callsBefore = current.fixture.calls.length;
      const result = await updateProfile(
        {
          dshHome: current.dshHome,
          profile: current.profile,
          to: target,
          interactive: false,
          yes: true,
        },
        current.fixture.runtime,
      );

      expect(result.exitCode).toBe(EXIT_CODES.USER_DECLINED);
      expect(result.metadata.preflight?.authorizationDelta).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind })]),
      );
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'E_USER_DECLINED' })]),
      );
      expect(
        current.fixture.calls.slice(callsBefore).filter((call) => call.startsWith('stage:')),
      ).toEqual([]);
    },
  );

  it('reports a new plugin and its newly requested build as separate authorization deltas', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile, plugin: { allowBuilds: true } });

    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: false,
        yes: true,
      },
      current.fixture.runtime,
    );

    expect(result.metadata.preflight?.authorizationDelta).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'new-plugin', plugin: 'example-bundle' }),
        expect.objectContaining({ kind: 'allow-build', authorization: 'example-bundle' }),
      ]),
    );
  });

  it('requires --yes for a normal non-interactive update and gives a runnable hint', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile });

    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: false,
      },
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'E_CONFIRMATION_REQUIRED',
          hint: expect.stringContaining('--yes'),
        }),
      ]),
    );
  });

  it('does not echo token-like DSH_HOME values in human or JSON confirmation output', async () => {
    const root = await home();
    const token = 'token-secret-value';
    const dshHome = join(root, token);
    await mkdir(dshHome);
    const source = await enginePack();
    const fixture = fakeRuntime();
    const installed = await installPack(
      { source, dshHome, interactive: false, frozen: true, yes: true },
      fixture.runtime,
    );
    expect(installed.exitCode).toBe(EXIT_CODES.SUCCESS);
    const target = await enginePack({ name: 'engine-pack' });
    const result = await updateProfile(
      { dshHome, profile: 'engine-pack', to: target, interactive: false },
      fixture.runtime,
    );
    expect(result.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(JSON.stringify(result)).not.toContain(token);

    const human: string[] = [];
    const json: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      human.push(String(chunk));
      return true;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      json.push(String(chunk));
      return true;
    });
    try {
      writeReport(result, false);
      writeReport(result, true);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      process.exitCode = undefined;
    }
    expect(human.join('')).not.toContain(token);
    expect(json.join('')).not.toContain(token);
  });

  it('uses a safe generic confirmation hint without echoing caller options', async () => {
    const current = await installedProfile();
    const target = await enginePack({ assets: true, name: current.profile });
    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        ours: true,
        only: ['skill:notes', 'setting:custom'],
        allowBuilds: ['direct-package'],
        allowUnverified: true,
        allowVersionMismatch: true,
        allowDangerFullAccess: true,
        interactive: false,
      },
      current.fixture.runtime,
    );
    const confirmation = result.diagnostics.find((item) => item.code === 'E_CONFIRMATION_REQUIRED');

    expect(confirmation?.hint).toBe(
      '审阅预检后执行：Re-run the same validated update command after review, adding --yes to confirm it.',
    );
    expect(confirmation?.hint).toContain('--yes');
    expect(confirmation?.hint).not.toContain(current.dshHome);
    expect(confirmation?.hint).not.toContain(current.profile);
    expect(confirmation?.hint).not.toContain(target);
    expect(confirmation?.hint).not.toContain('--ours');

    const theirsJson = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        theirs: true,
        json: true,
        interactive: false,
      },
      current.fixture.runtime,
    );
    const theirsConfirmation = theirsJson.diagnostics.find(
      (item) => item.code === 'E_CONFIRMATION_REQUIRED',
    );
    expect(theirsConfirmation?.hint).toBe(
      '审阅预检后执行：Re-run the same validated update command after review, adding --yes to confirm it.',
    );
    expect(theirsConfirmation?.hint).not.toContain(current.dshHome);
    expect(theirsConfirmation?.hint).not.toContain(target);
  });

  it('prompts an interactive normal update with the distinct update kind', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile });
    const runtime = fakeRuntime({ confirmations: [true] });

    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: true,
      },
      runtime.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(runtime.calls).toEqual(
      expect.arrayContaining([expect.stringMatching(/^confirm:update:更新 profile /u)]),
    );
  });

  it('prompts each missing authorization interactively and reaches apply only after acceptance', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile, plugin: { allowBuilds: true } });
    const runtime = fakeRuntime({ confirmations: [true, true] });

    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: true,
        yes: true,
      },
      runtime.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    const prompts = runtime.calls.filter((call) => call.startsWith('confirm:'));
    expect(prompts).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^confirm:new-plugin:新增插件：example-bundle（精确解析结果）$/u),
        'confirm:allow-build:example-bundle',
      ]),
    );
    const newPluginPrompt = prompts.find((call) => call.startsWith('confirm:new-plugin:')) ?? '';
    expect(newPluginPrompt).not.toContain('\u0000');
    expect(newPluginPrompt).not.toContain('new plugin');
  });

  it('reports E_USER_DECLINED when an interactive authorization is declined', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile, plugin: { allowBuilds: false } });
    const runtime = fakeRuntime({ confirmations: [false] });

    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: true,
        yes: true,
      },
      runtime.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_USER_DECLINED' })]),
    );
    expect(runtime.calls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^confirm:new-plugin:新增插件：example-bundle（精确解析结果）$/u),
      ]),
    );
  });

  it('names an existing plugin identity change without exposing its control-delimited identity', async () => {
    const current = await installedProfile({ plugin: { allowBuilds: false } });
    const target = await enginePack({ name: current.profile, plugin: { allowBuilds: false } });
    const runtime = fakeRuntime({ confirmations: [true] });
    const resolvePlugins = runtime.runtime.resolvePlugins.bind(runtime.runtime);
    runtime.runtime.resolvePlugins = async (material, options) => {
      const resolution = await resolvePlugins(material, options);
      return {
        ...resolution,
        plugins: resolution.plugins.map((plugin) => ({
          ...plugin,
          resolved: { version: '2.0.0' },
        })),
      };
    };

    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: true,
        yes: true,
      },
      runtime.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.SOURCE_NETWORK_INTEGRITY);
    expect(runtime.calls).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^confirm:new-plugin:插件精确解析结果变更：example-bundle$/u),
      ]),
    );
    expect(runtime.calls.join('\n')).not.toContain('\u0000');
  });

  it('applies a clean, authorized update transaction', async () => {
    const current = await installedProfile();
    const target = await enginePack({ name: current.profile });
    const result = await updateProfile(
      {
        dshHome: current.dshHome,
        profile: current.profile,
        to: target,
        interactive: false,
        yes: true,
      },
      current.fixture.runtime,
    );

    expect(result.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(result.metadata.profile).toBe(current.profile);
    expect(result.metadata.status).toBe('updated');
    expect(result.metadata.generation).toBe(2);
    expect(current.fixture.calls).toContain('stage:metadata');
  });
});
