import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { materializeSource, SourceError } from '../src/adapters/source.js';
import { EXIT_CODES } from '../src/exit-codes.js';
import { initializePack } from '../src/init/engine.js';
import { installPack } from '../src/install/engine.js';
import { packDirectory } from '../src/pack/engine.js';
import { removeFixtureDirectory } from './fixture-cleanup.js';
import { fakeRuntime } from './install-engine-fixture.js';

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-pack-engine-'));
  roots.push(root);
  return root;
}

async function fingerprint(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name);
      const state = await lstat(absolute);
      if (state.isDirectory()) await visit(absolute);
      else {
        const bytes = await readFile(absolute);
        result.push(
          `${relative(root, absolute).replaceAll('\\', '/')}:${bytes.byteLength}:${createHash('sha256').update(bytes).digest('hex')}`,
        );
      }
    }
  };
  await visit(root);
  return result.sort();
}

async function packFixture(): Promise<{ root: string; output: string }> {
  const parent = await temporary();
  const root = join(parent, 'pack');
  const output = join(parent, 'dist');
  const init = await initializePack({
    author: 'pack test',
    description: 'A reproducible pack.',
    directory: root,
    license: 'MIT',
    name: 'repro-pack',
    template: 'skills',
    version: '0.1.0',
  });
  expect(init.exitCode).toBe(EXIT_CODES.SUCCESS);
  return { root, output };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeFixtureDirectory(root)));
});

describe('packDirectory', () => {
  it('produces a manifest, SRI sidecar, and byte-identical archives on repeated runs', async () => {
    const { root, output } = await packFixture();
    const first = await packDirectory({ directory: root, output });
    expect(first.exitCode).toBe(EXIT_CODES.SUCCESS);
    const archive = first.metadata.archive as string;
    const firstBytes = await readFile(archive);
    const firstSri = await readFile(`${archive}.sha512`, 'utf8');

    await rm(output, { recursive: true });
    const second = await packDirectory({ directory: root, output });
    const secondBytes = await readFile(second.metadata.archive as string);
    const secondSri = await readFile(`${second.metadata.archive as string}.sha512`, 'utf8');

    expect(second.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(secondBytes.equals(firstBytes)).toBe(true);
    expect(secondSri).toBe(firstSri);
    expect(firstSri.trim()).toBe(
      `sha512-${createHash('sha512').update(firstBytes).digest('base64')}`,
    );
    const manifest = JSON.parse(await readFile(first.metadata.manifest as string, 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.files).toEqual(
      expect.arrayContaining([{ path: 'pack.yml', sha256: expect.any(String) }]),
    );
  });

  it('passes its own file: archive and SRI through install dry-run, then rejects one-byte tampering', async () => {
    const { root, output } = await packFixture();
    const report = await packDirectory({ directory: root, output });
    const archive = report.metadata.archive as string;
    const sri = (await readFile(`${archive}.sha512`, 'utf8')).trim();
    const dshHome = join(await temporary(), 'dsh-home');
    const fake = fakeRuntime();
    const runtime = { ...fake.runtime, materializeSource };
    const installed = await installPack(
      {
        source: `file:${archive}#${sri}`,
        dshHome,
        dryRun: true,
        interactive: false,
        json: true,
      },
      runtime,
    );
    expect(installed.exitCode).toBe(EXIT_CODES.SUCCESS);

    const original = await readFile(archive);
    const mutated = Buffer.from(original);
    mutated[mutated.length - 1] = (mutated[mutated.length - 1] ?? 0) ^ 0xff;
    await writeFile(archive, mutated);
    const rejected = await installPack(
      { source: `file:${archive}#${sri}`, dshHome, dryRun: true, interactive: false, json: true },
      runtime,
    );
    expect(rejected).toMatchObject({
      exitCode: EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
      diagnostics: [expect.objectContaining({ code: 'SOURCE_INTEGRITY' })],
    });
    expect(new SourceError('test', 20, 'test')).toBeInstanceOf(Error);
  });

  it('rejects a credential in README without producing any dist files', async () => {
    const { root, output } = await packFixture();
    const before = await fingerprint(root);
    await writeFile(join(root, 'README.md'), 'token: ghp_1234567890abcdefghijklmnop\n', 'utf8');

    const report = await packDirectory({ directory: root, output });

    expect(report.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(report.diagnostics.some(({ code }) => code.startsWith('E_SECRET'))).toBe(true);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fingerprint(root)).not.toEqual(before);
  });

  it('rejects a credential in semantic payload without deleting it or creating dist output', async () => {
    const { root, output } = await packFixture();
    const skill = join(root, 'skills', 'example-skill', 'SKILL.md');
    await writeFile(
      skill,
      '---\nname: example-skill\ndescription: token ghp_1234567890abcdefghijklmnop\n---\n',
      'utf8',
    );
    const before = await readFile(skill, 'utf8');

    const report = await packDirectory({ directory: root, output });

    expect(report.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(await readFile(skill, 'utf8')).toBe(before);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records a manifest digest that matches the bytes actually packed, for every entry', async () => {
    const { root, output } = await packFixture();
    const report = await packDirectory({ directory: root, output });
    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);

    const manifest = JSON.parse(await readFile(report.metadata.manifest as string, 'utf8')) as {
      files: readonly { path: string; sha256: string }[];
    };

    // manifest.json is the audit record — the thing that lets someone check which bytes went
    // into the archive. Asserting the digests are strings only proves the field exists; it would
    // pass just as happily if every entry carried the digest of an empty buffer. Recompute each
    // one from the source file instead.
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const { path, sha256: recorded } of manifest.files) {
      const bytes = await readFile(join(root, ...path.split('/')));
      expect({ path, sha256: recorded }).toEqual({
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  });

  it('waives only the entropy heuristic for pack.lock.yml, never a pattern-matched token', async () => {
    const { root, output } = await packFixture();
    const lock = join(root, 'pack.lock.yml');
    // The lock legitimately carries base64 SRI digests, so the entropy heuristic is waived for
    // this one file. Widening that waiver to every rule would let a real credential ride along
    // inside an artifact whose whole selling point is being auditable.
    //
    // Validation must be injected as successful, and the token written during the collect phase:
    // `validate-pack.ts` keeps its own copy of this waiver and would otherwise catch the token
    // first, leaving this test green no matter what `pack` itself does. Appending the token as a
    // YAML comment keeps the document parseable so the only possible failure is the secret scan.
    const report = await packDirectory(
      { directory: root, output },
      {
        validate: async () => ({
          diagnostics: [],
          exitCode: EXIT_CODES.SUCCESS,
          metadata: { source: root, valid: true },
        }),
        onScanPhase: async (phase) => {
          if (phase === 'collect')
            await writeFile(
              lock,
              `${await readFile(lock, 'utf8')}# token ghp_1234567890abcdefghijklmnop\n`,
              'utf8',
            );
        },
      },
    );

    expect(report.exitCode).toBe(EXIT_CODES.SECURITY);
    expect(report.diagnostics.some(({ code }) => code.startsWith('E_SECRET'))).toBe(true);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when strict validation or collection fails', async () => {
    const { root, output } = await packFixture();
    const validation = await packDirectory(
      { directory: root, output },
      {
        validate: async () => ({
          diagnostics: [
            {
              code: 'E_TEST_VALIDATE',
              severity: 'error' as const,
              message: 'invalid',
              hint: 'test',
              evidence: 'local' as const,
            },
          ],
          exitCode: EXIT_CODES.CONTRACT,
          metadata: { source: root, valid: false },
        }),
      },
    );
    expect(validation.exitCode).toBe(EXIT_CODES.CONTRACT);

    const missing = await packDirectory({ directory: join(root, 'missing'), output });
    expect(missing.exitCode).toBe(EXIT_CODES.CONTRACT);
  });

  it('executes each scan phase before producing output', async () => {
    const { root, output } = await packFixture();
    const phases: string[] = [];
    const report = await packDirectory(
      { directory: root, output },
      { onScanPhase: async (phase) => void phases.push(phase) },
    );
    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(phases).toEqual(['collect', 'write', 'post-write']);
  });

  it('runs the collect scan even when validation is injected as successful', async () => {
    const { root, output } = await packFixture();
    const report = await packDirectory(
      { directory: root, output },
      {
        validate: async () => ({
          diagnostics: [],
          exitCode: EXIT_CODES.SUCCESS,
          metadata: { source: root, valid: true },
        }),
        onScanPhase: async (phase) => {
          if (phase === 'collect')
            await writeFile(
              join(root, 'README.md'),
              'token: ghp_1234567890abcdefghijklmnop\n',
              'utf8',
            );
        },
      },
    );
    expect(report.exitCode).toBe(EXIT_CODES.SECURITY);
  });

  it('fails at the post-write scan if source bytes change during archive creation', async () => {
    const { root, output } = await packFixture();
    const report = await packDirectory(
      { directory: root, output },
      {
        onScanPhase: async (phase) => {
          if (phase === 'post-write')
            await writeFile(
              join(root, 'README.md'),
              'token: ghp_1234567890abcdefghijklmnop\n',
              'utf8',
            );
        },
      },
    );
    expect(report.exitCode).toBe(EXIT_CODES.SECURITY);
    await expect(readdir(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports malformed or unwritable output without publishing partial artifacts', async () => {
    const { root, output } = await packFixture();
    await writeFile(output, 'not a directory', 'utf8');
    const report = await packDirectory({ directory: root, output });
    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(await readFile(output, 'utf8')).toBe('not a directory');
  });

  it('uses the default dist output and excludes it from the reproducible input tree', async () => {
    const { root } = await packFixture();
    const first = await packDirectory({ directory: root });
    expect(first.exitCode).toBe(EXIT_CODES.SUCCESS);
    const firstBytes = await readFile(first.metadata.archive as string);
    const second = await packDirectory({ directory: root });
    expect(second.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(await readFile(second.metadata.archive as string)).toEqual(firstBytes);
  });

  it('fails closed when an injected validation gate allows a missing manifest', async () => {
    const { root, output } = await packFixture();
    await rm(join(root, 'pack.yml'));
    const report = await packDirectory(
      { directory: root, output },
      {
        validate: async () => ({
          diagnostics: [],
          exitCode: EXIT_CODES.SUCCESS,
          metadata: { source: root, valid: true },
        }),
      },
    );
    expect(report.exitCode).toBe(EXIT_CODES.CONTRACT);
    expect(report.diagnostics).toEqual([expect.objectContaining({ code: 'E_PACK_MANIFEST' })]);
  });

  it('excludes ignored, unknown, and symbolic-link entries from an injected-valid source tree', async () => {
    const { root, output } = await packFixture();
    await writeFile(join(root, 'unknown.bin'), 'ignored by archive collection', 'utf8');
    await mkdir(join(root, '.git'));
    await writeFile(
      join(root, '.git', 'config'),
      'token: ghp_1234567890abcdefghijklmnop\n',
      'utf8',
    );
    const report = await packDirectory(
      { directory: root, output },
      {
        validate: async () => ({
          diagnostics: [],
          exitCode: EXIT_CODES.SUCCESS,
          metadata: { source: root, valid: true },
        }),
      },
    );
    expect(report.exitCode).toBe(EXIT_CODES.SUCCESS);
    const manifest = JSON.parse(await readFile(report.metadata.manifest as string, 'utf8')) as {
      files: Array<{ path: string }>;
    };
    expect(manifest.files.map(({ path }) => path)).not.toContain('unknown.bin');
    expect(manifest.files.map(({ path }) => path)).not.toContain('.git/config');
  });
});
