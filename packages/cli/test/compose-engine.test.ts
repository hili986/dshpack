import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePack } from '@dshpack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import {
  type ComposeDependencies,
  type ComposeMaterializedSource,
  composePack,
} from '../src/compose/engine.js';
import { EXIT_CODES } from '../src/exit-codes.js';
import { installPack } from '../src/install/engine.js';
import type { ValidatedPackMaterial } from '../src/install/read.js';
import { validateLocalPack } from '../src/validation/validate-pack.js';
import { removeFixtureDirectory } from './fixture-cleanup.js';
import { fakeRuntime } from './install-engine-fixture.js';

const roots: string[] = [];
const github = 'github:dsh-packs/web-dev#3414f1af3fd674998cea81716586f4716a538f50';

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-compose-'));
  roots.push(root);
  return root;
}

function material(
  id: string | readonly string[],
  from: string,
  license = 'MIT',
  content?: string,
): ComposeMaterializedSource {
  const ids = typeof id === 'string' ? [id] : id;
  const primary = ids[0] as string;
  const skillContent = (skill: string) =>
    content ?? `---\nname: ${skill}\ndescription: Source ${skill}.\n---\n\n# ${skill}\n`;
  const pack: ValidatedPackMaterial = {
    manifest: {
      formatVersion: 0,
      name: `${primary}-source`,
      version: '0.1.0',
      description: 'Source fixture.',
      author: 'dsh-packs',
      license,
      dsh: { tested: ['0.1.0-rc.6'] },
      plugins: [],
      mcp: [],
      defaults: { permissionPreset: 'workspace-write' },
    },
    paths: ids.map((skill) => `skills/${skill}/SKILL.md`),
    files: ids.map((skill) => ({
      path: `skills/${skill}/SKILL.md`,
      sha512: 'sha512-AQID',
      contentBase64: Buffer.from(skillContent(skill)).toString('base64'),
    })),
    sourceFiles: [],
    manifestDigest: 'sha256-AQID',
  };
  return { from, material: pack, license, cleanup: async () => undefined };
}

async function composeFile(
  root: string,
  include: unknown[],
  resolve: unknown[] = [],
): Promise<string> {
  const path = join(root, 'compose.yml');
  await writeFile(
    path,
    stringify({
      composeVersion: 0,
      name: 'research-kit',
      version: '0.1.0',
      description: 'A composed research pack.',
      author: 'dsh-packs',
      license: 'MIT',
      include,
      resolve,
      mcp: [],
      defaults: { permissionPreset: 'workspace-write' },
    }),
    'utf8',
  );
  return path;
}

function dependencies(sources: Record<string, ComposeMaterializedSource>): ComposeDependencies {
  return {
    materializeSource: vi.fn(
      async (selection: { from: string }) => sources[selection.from] as ComposeMaterializedSource,
    ),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeFixtureDirectory(root)));
});

describe('composePack', () => {
  it('carries an archive skipped-entry warning into the compose report without materializing it', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const archiveWarning = {
      code: 'E_ARCHIVE_ENTRY_SKIPPED',
      severity: 'warning' as const,
      message: 'Skipped non-regular archive entry: skills/link.',
      hint: 'The entry was not deployed or followed.',
      evidence: 'local' as const,
    };
    const sourceMaterial = {
      ...material('citation', './local-pack'),
      diagnostics: [archiveWarning],
    } as unknown as ComposeMaterializedSource;

    const report = await composePack(
      { composeFile: source, output },
      dependencies({ './local-pack': sourceMaterial }),
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      diagnostics: [
        expect.objectContaining({ code: 'E_ARCHIVE_ENTRY_SKIPPED', severity: 'warning' }),
      ],
    });
    const pack = parsePack(await readFile(join(output, 'pack.yml'), 'utf8')).value;
    expect(JSON.stringify(pack)).not.toContain('skills/link');
  });

  it('writes the resolved GitHub SHA to provenance and accepts a raw prefer directive', async () => {
    const root = await temporary();
    const bare = 'https://github.com/owner/repo';
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const pinned = `github:owner/repo#${commit}`;
    const source = await composeFile(
      root,
      [{ from: bare, skills: ['citation'] }],
      [{ id: 'citation', prefer: bare }],
    );
    const output = join(root, 'output');
    const report = await composePack(
      { composeFile: source, output },
      dependencies({ [bare]: material('citation', pinned) }),
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        selected: [expect.objectContaining({ from: pinned })],
        sources: [pinned],
      },
    });
    const pack = parsePack(await readFile(join(output, 'pack.yml'), 'utf8')).value;
    expect(pack?.provenance).toEqual([expect.objectContaining({ from: pinned })]);
  });

  it('assembles profile, pinned GitHub, and local sources into a locked valid pack with full provenance', async () => {
    const root = await temporary();
    const source = await composeFile(root, [
      { from: 'profile:research', skills: ['outline'] },
      { from: github, skills: ['citation'] },
      { from: './local-pack', skills: ['*'] },
    ]);
    const output = join(root, 'output');
    const report = await composePack(
      { composeFile: source, output },
      dependencies({
        'profile:research': material('outline', 'profile:research'),
        [github]: material('citation', github),
        './local-pack': material('local-skill', './local-pack'),
      }),
    );

    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await validateLocalPack(output, { strict: true })).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
    });
    const pack = parsePack(await readFile(join(output, 'pack.yml'), 'utf8')).value;
    expect(pack?.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'citation',
          originalId: 'citation',
          from: github,
          license: 'MIT',
        }),
      ]),
    );
    expect(await readFile(join(output, 'skills', 'citation', 'SKILL.md'), 'utf8')).toContain(
      '# citation\n',
    );
    expect(await readFile(join(output, 'pack.lock.yml'), 'utf8')).toContain('generatedBy:');
    const installed = await installPack(
      {
        source: output,
        dshHome: join(root, 'isolated-dsh-home'),
        dryRun: true,
        interactive: false,
        json: true,
      },
      fakeRuntime().runtime,
    );
    expect(installed.exitCode).toBe(EXIT_CODES.SUCCESS);
  });

  it('fails closed for every missing skill and lists source choices before creating the target', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['missing'] }]);
    const output = join(root, 'output');
    const report = await composePack(
      { composeFile: source, output },
      dependencies({ './local-pack': material('available', './local-pack') }),
    );

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({ code: 'E_COMPOSE_SKILL_MISSING', hint: '可选 id: available' }),
    ]);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports every unresolved conflict and publishes no target', async () => {
    const root = await temporary();
    const source = await composeFile(root, [
      { from: 'profile:first', skills: ['citation', 'outline'] },
      { from: './local-pack', skills: ['citation', 'outline'] },
    ]);
    const output = join(root, 'output');
    const report = await composePack(
      { composeFile: source, output },
      dependencies({
        'profile:first': material(['citation', 'outline'], 'profile:first'),
        './local-pack': material(['citation', 'outline'], './local-pack'),
      }),
    );

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(report.diagnostics.filter(({ code }) => code === 'E_COMPOSE_CONFLICT')).toHaveLength(2);
    expect(report.diagnostics.map(({ path }) => path)).toEqual(
      expect.arrayContaining(['citation', 'outline']),
    );
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an unknown license as a warning during dry run', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const report = await composePack(
      { composeFile: source, output, dryRun: true },
      dependencies({ './local-pack': material('citation', './local-pack', 'UNLICENSED') }),
    );

    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(report.diagnostics.map(({ code, severity }) => ({ code, severity }))).toEqual([
      { code: 'W_COMPOSE_UNKNOWN_LICENSE', severity: 'warning' },
    ]);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the dangerous license acknowledgement before writing', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const sourceMaterial = material('citation', './local-pack', 'UNLICENSED');
    const report = await composePack(
      { composeFile: source, output },
      dependencies({ './local-pack': sourceMaterial }),
    );
    expect(report.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'W_COMPOSE_UNKNOWN_LICENSE', severity: 'warning' }),
        expect.objectContaining({ code: 'E_COMPOSE_UNKNOWN_LICENSE_CONFIRM', severity: 'error' }),
      ]),
    );
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows an unknown license in dry run but refuses the same source during write phase', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const sourceMaterial = material('citation', './local-pack', 'UNLICENSED');

    const preview = await composePack(
      { composeFile: source, output, dryRun: true },
      dependencies({ './local-pack': sourceMaterial }),
    );
    expect(preview).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      diagnostics: [expect.objectContaining({ code: 'W_COMPOSE_UNKNOWN_LICENSE' })],
      metadata: { dryRun: true, sources: ['./local-pack'] },
    });

    const rejected = await composePack(
      { composeFile: source, output },
      dependencies({ './local-pack': sourceMaterial }),
    );
    expect(rejected).toMatchObject({
      exitCode: EXIT_CODES.USER_DECLINED,
      metadata: { dryRun: false, sources: [] },
    });
    expect(rejected.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'W_COMPOSE_UNKNOWN_LICENSE' }),
        expect.objectContaining({ code: 'E_COMPOSE_UNKNOWN_LICENSE_CONFIRM' }),
      ]),
    );
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes unknown-license provenance after the dangerous acknowledgement', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const accepted = await composePack(
      { composeFile: source, output, allowUnknownLicense: true },
      dependencies({ './local-pack': material('citation', './local-pack', 'UNLICENSED') }),
    );
    expect(accepted.exitCode).toBe(EXIT_CODES.SUCCESS);
    const pack = parsePack(await readFile(join(output, 'pack.yml'), 'utf8')).value;
    expect(pack?.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ license: 'UNLICENSED' })]),
    );
  });

  it('keeps a declared-license mismatch visible while accepting a rename resolution without prefer', async () => {
    const root = await temporary();
    const source = await composeFile(
      root,
      [{ from: './local-pack', skills: ['citation'] }],
      [{ id: 'citation', rename: 'citation-renamed' }],
    );
    const output = join(root, 'output');

    const report = await composePack(
      { composeFile: source, output },
      dependencies({ './local-pack': material('citation', './local-pack', 'Apache-2.0') }),
    );

    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'W_COMPOSE_LICENSE_MISMATCH' })]),
    );
    expect(report.metadata.selected).toEqual([
      expect.objectContaining({ id: 'citation-renamed', originalId: 'citation' }),
    ]);
  });

  it('rejects a credential hit with exit 31 and leaves both source bytes and target untouched', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const content = '# Citation\n\ntoken: ghp_1234567890abcdefghijklmnop\n';
    const sourceMaterial = material('citation', './local-pack', 'MIT', content);
    const report = await composePack(
      { composeFile: source, output },
      dependencies({ './local-pack': sourceMaterial }),
    );

    expect(report.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(report.diagnostics.some(({ code }) => code.startsWith('E_SECRET'))).toBe(true);
    expect(
      Buffer.from(sourceMaterial.material.files[0]?.contentBase64 ?? '', 'base64').toString(),
    ).toBe(content);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    {
      adapter: EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      code: 'SOURCE_INTEGRITY',
      expected: EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      label: 'keeps the adapter classification for a tampered tarball',
    },
    {
      adapter: EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      code: 'E_SECRET_TOKEN',
      expected: EXIT_CODES.SECURITY,
      label: 'still refuses to downgrade a credential hit to the adapter code',
    },
  ])('$label', async ({ adapter, code, expected }) => {
    // The engine used to fold every source failure into the generic contract code, so a tampered
    // tarball reported "your compose.yml is wrong" and automation reading the exit code would
    // retry a fetch it must not retry. The source-level test asserts the adapter builds the right
    // failure; only this one asserts the engine still carries it out to the caller — the layer the
    // user actually sees. Deleting `adapterExit` leaves every other compose test green.
    const root = await temporary();
    const source = await composeFile(root, [{ from: './broken-pack', skills: ['citation'] }]);
    const output = join(root, 'output');

    const report = await composePack(
      { composeFile: source, output },
      {
        materializeSource: vi.fn(async () => ({
          diagnostics: [
            {
              code,
              severity: 'error' as const,
              message: 'source rejected',
              hint: '',
              evidence: 'local' as const,
            },
          ],
          exitCode: adapter,
        })),
      },
    );

    expect({ exitCode: report.exitCode, code: report.diagnostics[0]?.code }).toEqual({
      exitCode: expected,
      code,
    });
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs in dry-run mode without creating the requested target directory', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'absent-output');
    const report = await composePack(
      { composeFile: source, output, dryRun: true },
      dependencies({ './local-pack': material('citation', './local-pack') }),
    );

    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(report.metadata.dryRun).toBe(true);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back the entire staging tree when the lock gate fails', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const report = await composePack(
      { composeFile: source, output },
      {
        ...dependencies({ './local-pack': material('citation', './local-pack') }),
        generateLock: vi.fn().mockResolvedValue({
          diagnostics: [
            {
              code: 'E_TEST_LOCK',
              severity: 'error',
              message: 'lock failed',
              hint: 'test',
              evidence: 'local',
            },
          ],
          exitCode: EXIT_CODES.CONTRACT,
          metadata: { source: output, written: false },
        }),
      },
    );

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((name) => name.includes('dshpack-compose-'))).toEqual([]);
  });

  it('defaults the target to the pack name beside compose.yml, with resolve and mcp omitted', async () => {
    // The fixture writer always emits `output`, `resolve: []` and `mcp: []`. A hand-written
    // minimal compose.yml has none of them, and that is the shape a first-time user produces.
    const root = await temporary();
    const source = join(root, 'compose.yml');
    await writeFile(
      source,
      stringify({
        composeVersion: 0,
        name: 'research-kit',
        version: '0.1.0',
        description: 'A composed research pack.',
        author: 'dsh-packs',
        license: 'MIT',
        include: [{ from: './local-pack', skills: ['citation'] }],
        defaults: { permissionPreset: 'workspace-write' },
      }),
      'utf8',
    );

    const report = await composePack(
      { composeFile: source },
      dependencies({ './local-pack': material('citation', './local-pack') }),
    );

    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(report.metadata.directory).toBe(join(root, 'research-kit'));
    await expect(readFile(join(root, 'research-kit', 'pack.yml'), 'utf8')).resolves.toContain(
      'name: research-kit',
    );
  });

  it('refuses an unparseable compose.yml without creating anything', async () => {
    const root = await temporary();
    const source = join(root, 'compose.yml');
    await writeFile(source, 'include: [\n', 'utf8');

    const report = await composePack({ composeFile: source }, dependencies({}));

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(report.diagnostics.length).toBeGreaterThan(0);
    expect((await readdir(root)).sort()).toEqual(['compose.yml']);
  });

  it('refuses to publish over a target that already exists', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    await mkdir(output, { recursive: true });

    const report = await composePack(
      { composeFile: source, output },
      dependencies({ './local-pack': material('citation', './local-pack') }),
    );

    expect(report.exitCode).not.toBe(EXIT_CODES.SUCCESS);
    // The pre-existing directory must be left exactly as it was, not merged into or replaced.
    expect(await readdir(output)).toEqual([]);
  });

  it('reports an existing target as a non-dry-run write-phase contract refusal', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    await mkdir(output, { recursive: true });

    const report = await composePack(
      { composeFile: source, output },
      dependencies({ './local-pack': material('citation', './local-pack') }),
    );

    expect(report).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_COMPOSE_OUTPUT' })],
      metadata: {
        directory: output,
        dryRun: false,
        selected: [{ from: './local-pack', id: 'citation', originalId: 'citation' }],
        sources: [],
      },
    });
    expect(await readdir(output)).toEqual([]);
  });

  it('carries a flat skills/<id>.md source through, and marks an unlicensed one in provenance', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const flat = material('citation', './local-pack');
    const body = '---\nname: citation\ndescription: Flat skill.\n---\n\n# citation\n';
    const { license: _dropped, ...withoutLicense } = flat;
    const unlicensed: ComposeMaterializedSource = {
      ...withoutLicense,
      material: {
        ...flat.material,
        manifest: { ...flat.material.manifest, license: 'UNLICENSED' },
        paths: ['skills/citation.md'],
        files: [
          {
            path: 'skills/citation.md',
            sha512: 'sha512-AQID',
            contentBase64: Buffer.from(body).toString('base64'),
          },
        ],
      },
    };

    const report = await composePack(
      { composeFile: source, output, allowUnknownLicense: true },
      dependencies({ './local-pack': unlicensed }),
    );

    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
    await expect(readFile(join(output, 'skills', 'citation.md'), 'utf8')).resolves.toBe(body);
    const pack = parsePack(await readFile(join(output, 'pack.yml'), 'utf8')).value;
    expect(pack?.provenance).toEqual([
      expect.objectContaining({ id: 'citation', originalId: 'citation', license: 'UNLICENSED' }),
    ]);
  });

  it('uses the real source materializer when none is injected', async () => {
    // Every other engine test injects `materializeSource`, so the wiring to the shipped
    // implementation is never exercised. A source that cannot exist proves the default is reached
    // without needing the network.
    const root = await temporary();
    const source = await composeFile(root, [{ from: './definitely-not-here', skills: ['*'] }]);
    const output = join(root, 'output');

    const report = await composePack({ composeFile: source, output });

    expect(report.exitCode).not.toBe(EXIT_CODES.SUCCESS);
    expect(report.diagnostics[0]?.path).toBe('./definitely-not-here');
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('catches a credential that only lock generation introduced, on the third scan', async () => {
    // The materials pass the first scan, so this can only be caught after the lock is written.
    // Without that third pass the pack ships with the token inside pack.lock.yml — and the lock is
    // exactly where a generator is most likely to echo something it read.
    //
    // `validate` is stubbed to succeed on purpose: the real one runs its own credential scan and
    // catches this token too, so leaving it in place made this test pass with the third scan
    // deleted. It was measuring the validator, not the scan it names.
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const report = await composePack(
      { composeFile: source, output },
      {
        ...dependencies({ './local-pack': material('citation', './local-pack') }),
        generateLock: vi.fn(async (staging: string) => {
          await writeFile(
            join(staging, 'pack.lock.yml'),
            'generatedBy: test\ntoken: ghp_1234567890abcdefghijklmnop\n',
          );
          return { diagnostics: [], exitCode: EXIT_CODES.SUCCESS, metadata: {} };
        }) as never,
        validate: vi
          .fn()
          .mockResolvedValue({ diagnostics: [], exitCode: EXIT_CODES.SUCCESS, metadata: {} }),
      },
    );

    expect(report.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(report.diagnostics.some(({ code }) => code.startsWith('E_SECRET'))).toBe(true);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((name) => name.includes('dshpack-compose-'))).toEqual([]);
  });

  it('publishes nothing when the composed pack fails its own strict validation', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const report = await composePack(
      { composeFile: source, output },
      {
        ...dependencies({ './local-pack': material('citation', './local-pack') }),
        validate: vi.fn().mockResolvedValue({
          diagnostics: [
            {
              code: 'E_PACK_STRICT',
              severity: 'error',
              message: 'strict validation failed',
              hint: 'test',
              evidence: 'local',
            },
          ],
          exitCode: EXIT_CODES.CONTRACT,
          metadata: {},
        }),
      },
    );

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_PACK_STRICT' })]),
    );
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an unexpected write failure without leaving a half-published target', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const report = await composePack(
      { composeFile: source, output },
      {
        ...dependencies({ './local-pack': material('citation', './local-pack') }),
        generateLock: vi.fn().mockRejectedValue(new Error('the volume disappeared')),
      },
    );

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_COMPOSE_WRITE' })]),
    );
    // The raw error must not reach the report — it can carry paths the caller never provided.
    expect(JSON.stringify(report.diagnostics)).not.toContain('the volume disappeared');
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((name) => name.includes('dshpack-compose-'))).toEqual([]);
  });

  it('reports an unreadable compose file as a contract failure in dry run too', async () => {
    const root = await temporary();
    const report = await composePack({
      composeFile: join(root, 'missing-compose.yml'),
      dryRun: true,
    });

    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(report.metadata.dryRun).toBe(true);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_COMPOSE_READ' })]),
    );
  });

  it('refuses at the staged-write re-scan when the injected scanner flags what the first scan missed', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    let calls = 0;
    const report = await composePack(
      { composeFile: source, output },
      {
        ...dependencies({ './local-pack': material('citation', './local-pack') }),
        secretScanner: () => {
          calls += 1;
          if (calls === 1) return [];
          return [
            {
              code: 'E_SECRET_HIGH_ENTROPY',
              severity: 'error',
              message: 'Staged content resembles a credential.',
              hint: 'Remove it from the source.',
              evidence: 'local',
              path: 'skills/citation/SKILL.md',
            },
          ];
        },
      },
    );

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(report.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_SECRET_HIGH_ENTROPY' })]),
    );
  });
});
