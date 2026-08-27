import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../..');
const verifyReleasePack = resolve(repository, 'scripts/verify-release-pack.mjs');
const coreManifest = resolve(repository, 'packages/core/package.json');
const cliManifest = resolve(repository, 'packages/cli/package.json');

function run(script: string) {
  return spawnSync(process.execPath, [script], { cwd: repository, encoding: 'utf8' });
}

function output(result: ReturnType<typeof run>): string {
  return `${result.stdout}\n${result.stderr}`;
}

describe('release tarball verification', () => {
  it('unpacks both publishable tarballs and validates their required and forbidden contents', () => {
    const result = run(verifyReleasePack);

    expect(result.status, output(result)).toBe(0);
    expect(result.stdout).toContain('release tarballs verified');
  }, 30_000);

  it('uses npm_execpath when a Windows Corepack layout has no sibling pnpm command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-corepack-pnpm-'));
    const pnpmExecPath = join(root, 'pnpm.cjs');
    try {
      await writeFile(pnpmExecPath, 'module.exports = {};\n', 'utf8');
      const evaluation = [
        `import { pnpmInvocation } from ${JSON.stringify(pathToFileURL(verifyReleasePack).href)};`,
        `process.stdout.write(JSON.stringify(pnpmInvocation('win32', ${JSON.stringify({ PATH: '', npm_execpath: pnpmExecPath })})));`,
      ].join('\n');
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', evaluation], {
        cwd: repository,
        encoding: 'utf8',
      });
      expect(result.status, output(result)).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        args: [pnpmExecPath],
        command: process.execPath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('turns red when the core schema directory is omitted from npm files and green after restore', async () => {
    const original = await readFile(coreManifest, 'utf8');
    const manifest = JSON.parse(original) as { files: string[] };
    try {
      await writeFile(
        coreManifest,
        `${JSON.stringify({ ...manifest, files: ['dist'] }, null, 2)}\n`,
        'utf8',
      );
      const red = run(verifyReleasePack);
      console.info(`RELEASE_PACK_SCHEMA_OMISSION_RED status=${red.status} ${output(red).trim()}`);
      expect(red.status).not.toBe(0);
      expect(output(red)).toMatch(/missing required schema/u);
    } finally {
      await writeFile(coreManifest, original, 'utf8');
    }

    const green = run(verifyReleasePack);
    console.info(`RELEASE_PACK_SCHEMA_OMISSION_GREEN status=${green.status}`);
    expect(green.status, output(green)).toBe(0);
  }, 30_000);

  it('turns red when required publish metadata is absent and green after restore', async () => {
    const original = await readFile(cliManifest, 'utf8');
    const manifest = JSON.parse(original) as Record<string, unknown>;
    try {
      const { license: _license, ...withoutLicense } = manifest;
      await writeFile(cliManifest, `${JSON.stringify(withoutLicense, null, 2)}\n`, 'utf8');
      const red = run(verifyReleasePack);
      console.info(`RELEASE_METADATA_MISSING_RED status=${red.status} ${output(red).trim()}`);
      expect(red.status).not.toBe(0);
      expect(output(red)).toMatch(/packages\/cli missing publish metadata: license/u);
    } finally {
      await writeFile(cliManifest, original, 'utf8');
    }

    const green = run(verifyReleasePack);
    console.info(`RELEASE_METADATA_MISSING_GREEN status=${green.status}`);
    expect(green.status, output(green)).toBe(0);
  }, 30_000);

  it('turns red when the dshpack tarball omits either required UI asset and green after restore', async () => {
    const original = await readFile(cliManifest, 'utf8');
    const manifest = JSON.parse(original) as Record<string, unknown>;
    try {
      await writeFile(
        cliManifest,
        `${JSON.stringify(
          { ...manifest, files: ['dist/index.js', 'dist/bin.js', 'README.md'] },
          null,
          2,
        )}\n`,
        'utf8',
      );
      const red = run(verifyReleasePack);
      console.info(`RELEASE_UI_ASSET_OMISSION_RED status=${red.status} ${output(red).trim()}`);
      expect(red.status).not.toBe(0);
      expect(output(red)).toMatch(
        /missing required UI asset: package\/dist\/ui\/(?:index\.html|app\.js)/u,
      );
    } finally {
      await writeFile(cliManifest, original, 'utf8');
    }

    const green = run(verifyReleasePack);
    console.info(`RELEASE_UI_ASSET_OMISSION_GREEN status=${green.status}`);
    expect(green.status, output(green)).toBe(0);
  }, 30_000);
});
