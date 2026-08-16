import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../..');
const verify = resolve(repository, 'scripts/verify-adr-text-encoding.mjs');
const temporaryRoots: string[] = [];

function run(root: string) {
  return spawnSync(process.execPath, [verify, root], { cwd: repository, encoding: 'utf8' });
}

function output(result: ReturnType<typeof run>): string {
  return `${result.stdout}\n${result.stderr}`;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('ADR text-evidence encoding guard', () => {
  it('turns red for a UTF-16 BOM evidence mutant and green after UTF-8 no-BOM rewrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-adr-encoding-'));
    temporaryRoots.push(root);
    const evidence = join(root, 'windows', 'capture.stdout.log');
    await mkdir(join(evidence, '..'), { recursive: true });
    await writeFile(
      evidence,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('mcp-context7\n', 'utf16le')]),
    );

    const red = run(root);
    console.info(`ADR_UTF16_BOM_RED status=${red.status} ${output(red).trim()}`);
    expect(red.status).not.toBe(0);
    expect(output(red)).toMatch(/UTF-16 BOM/u);

    await writeFile(evidence, 'mcp-context7\n', 'utf8');
    const green = run(root);
    console.info(`ADR_UTF16_BOM_GREEN status=${green.status} ${output(green).trim()}`);
    expect(green.status, output(green)).toBe(0);
  });
});
