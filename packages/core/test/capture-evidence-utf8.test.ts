import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const repository = resolve(import.meta.dirname, '../../..');
const capture = resolve(repository, 'scripts/capture-evidence-utf8.ps1');
const temporaryRoots: string[] = [];

function hasBom(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PowerShell evidence capture encoding', () => {
  it('writes stdout, stderr, and exit evidence as UTF-8 without a BOM', async () => {
    if (process.platform !== 'win32') {
      const source = await readFile(capture, 'utf8');
      expect(source).toContain('[System.Text.UTF8Encoding]::new($false)');
      expect(source).toContain('Write-Utf8NoBom -Path $StdoutPath');
      expect(source).toContain('Write-Utf8NoBom -Path $StderrPath');
      expect(source).toContain('Write-Utf8NoBom -Path $ExitPath');
      return;
    }

    const root = await mkdtemp(join(tmpdir(), 'dshpack-capture-encoding-'));
    temporaryRoots.push(root);
    const stdout = join(root, 'command.stdout.log');
    const stderr = join(root, 'command.stderr.log');
    const exit = join(root, 'command.exit.txt');
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        capture,
        '-FilePath',
        process.execPath,
        '-Arguments',
        '--version',
        '-StdoutPath',
        stdout,
        '-StderrPath',
        stderr,
        '-ExitPath',
        exit,
        '-WorkingDirectory',
        repository,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    console.info(`CAPTURE_UTF8_NOBOM status=${result.status} stdout=${result.stdout.trim()}`);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const path of [stdout, stderr, exit]) {
      expect(hasBom(await readFile(path))).toBe(false);
    }
    await expect(readFile(stdout, 'utf8')).resolves.toMatch(/^v\d+\.\d+\.\d+\r?\n$/u);
    await expect(readFile(stderr, 'utf8')).resolves.toBe('');
    await expect(readFile(exit, 'utf8')).resolves.toBe('0\n');
  });
});
