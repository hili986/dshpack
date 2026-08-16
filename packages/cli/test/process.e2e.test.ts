import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DshProcessError, runDsh } from '../src/adapters/process.js';

const fixtureDirectory = fileURLToPath(new URL('./e2e/shims/', import.meta.url));
const temporaryRoots: string[] = [];

function isolatedPath(shimDirectory: string): string {
  return [shimDirectory, dirname(process.execPath)].join(delimiter);
}

async function prepareShim(root: string, command: 'dsh' | 'npx'): Promise<string> {
  const shimDirectory = join(root, 'PATH 首位 shims with spaces');
  await mkdir(shimDirectory, { recursive: true });
  await copyFile(
    join(fixtureDirectory, 'process-shim.mjs'),
    join(shimDirectory, 'process-shim.mjs'),
  );
  if (process.platform === 'win32') {
    await copyFile(join(fixtureDirectory, `${command}.cmd`), join(shimDirectory, `${command}.cmd`));
  } else {
    const destination = join(shimDirectory, command);
    await copyFile(join(fixtureDirectory, command), destination);
    await chmod(destination, 0o755);
  }
  return shimDirectory;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('dsh process shim', () => {
  it('preserves spaces, Unicode, and # in argv through a PATH-first dsh shim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack W9 空格-'));
    temporaryRoots.push(root);
    const shimDirectory = await prepareShim(root, 'dsh');
    const cwd = join(root, '工作 cwd with spaces #1');
    const dshHome = join(root, 'DSH 家 with spaces');
    const argvLog = join(root, 'shim argv.jsonl');
    await mkdir(cwd, { recursive: true });
    const args = ['plugin', '--profile', '研究 profile #1', 'add', 'github:owner/repo#dead beef'];
    const fakeToken = 'ghp_1234567890abcdefghijklmnop';

    const result = await runDsh(args, {
      cwd,
      dshHome,
      env: {
        DSHPACK_NODE_EXE: process.execPath,
        DSHPACK_SHIM_ARGV_LOG: argvLog,
        DSHPACK_SHIM_STDERR: `Bearer ${fakeToken}\n`,
        DSHPACK_SHIM_STDOUT: `token: ${fakeToken}\nshim ok\n`,
        PATH: isolatedPath(shimDirectory),
      },
      timeout: 5_000,
    });

    expect(result.launcher).toBe('path');
    const records = (await readFile(argvLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    console.info(`W9_SHIM_ARGV ${JSON.stringify(records[0])}`);
    expect(records).toEqual([{ argv: args, cwd, dshHome }]);
    const persistedLog = await readFile(result.logPath, 'utf8');
    expect(persistedLog).toContain('shim ok');
    expect(persistedLog).toContain('[REDACTED]');
    expect(persistedLog).not.toContain(fakeToken);
  });

  it('uses the npx shim with the exact slow-path argv when dsh is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack W9 npx 空格-'));
    temporaryRoots.push(root);
    const shimDirectory = await prepareShim(root, 'npx');
    const cwd = join(root, '工作 cwd');
    const dshHome = join(root, 'DSH home');
    const argvLog = join(root, 'npx argv.jsonl');
    await mkdir(cwd, { recursive: true });
    const hints: string[] = [];

    const result = await runDsh(['--version', 'literal # value'], {
      cwd,
      dshHome,
      env: {
        DSHPACK_NODE_EXE: process.execPath,
        DSHPACK_SHIM_ARGV_LOG: argvLog,
        PATH: isolatedPath(shimDirectory),
      },
      onSlowPath: (message) => hints.push(message),
      timeout: 5_000,
    });

    expect(result.launcher).toBe('npx');
    const record = JSON.parse((await readFile(argvLog, 'utf8')).trim()) as {
      argv: string[];
      cwd: string;
      dshHome: string;
    };
    expect(record).toEqual({
      argv: ['--yes', '@deepseek-ai/dsh', '--version', 'literal # value'],
      cwd,
      dshHome,
    });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('npx --yes @deepseek-ai/dsh');
  });

  it('marks an actual Execa timeout and leaves descendant-tree killing disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack W9 timeout 空格-'));
    temporaryRoots.push(root);
    const shimDirectory = await prepareShim(root, 'dsh');
    const cwd = join(root, '工作 cwd');
    const dshHome = join(root, 'DSH home');
    const argvLog = join(root, 'timeout argv.jsonl');
    await mkdir(cwd, { recursive: true });
    const interruptions: string[] = [];

    let error: unknown;
    try {
      await runDsh(['plugin', 'list'], {
        cwd,
        dshHome,
        env: {
          DSHPACK_NODE_EXE: process.execPath,
          DSHPACK_SHIM_ARGV_LOG: argvLog,
          DSHPACK_SHIM_DELAY_MS: '200',
          PATH: isolatedPath(shimDirectory),
        },
        onInterrupted: (reason) => interruptions.push(reason),
        timeout: 20,
      });
    } catch (reason) {
      error = reason;
    }

    expect(error).toBeInstanceOf(DshProcessError);
    if (!(error instanceof DshProcessError)) throw new Error('expected DshProcessError');
    expect(error).toMatchObject({
      interrupted: true,
      interruptionReason: 'timeout',
      launcher: 'path',
      timedOut: true,
    });
    expect(interruptions).toEqual(['timeout']);
    await expect(readFile(error.logPath, 'utf8')).resolves.toContain('[status]');
  });
});
