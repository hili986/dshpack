import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
});
