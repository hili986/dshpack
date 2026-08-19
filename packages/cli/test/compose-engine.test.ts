import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
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

  it('requires the dangerous license acknowledgement and keeps unknown provenance explicit', async () => {
    const root = await temporary();
    const source = await composeFile(root, [{ from: './local-pack', skills: ['citation'] }]);
    const output = join(root, 'output');
    const sourceMaterial = material('citation', './local-pack', 'UNLICENSED');
    const withoutFlag = await composePack(
      { composeFile: source, output },
      dependencies({ './local-pack': sourceMaterial }),
    );
    expect(withoutFlag.exitCode).toBe(EXIT_CODES.USER_DECLINED);
    expect(withoutFlag.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'W_COMPOSE_UNKNOWN_LICENSE' })]),
    );
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });

    const accepted = await composePack(
      { composeFile: source, output, allowUnknownLicense: true },
      dependencies({ './local-pack': sourceMaterial }),
    );
    expect(accepted.exitCode).toBe(EXIT_CODES.SUCCESS);
    const pack = parsePack(await readFile(join(output, 'pack.yml'), 'utf8')).value;
    expect(pack?.provenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ license: 'UNLICENSED' })]),
    );
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
});
