import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const binPath =
  process.env.DSHPACK_E2E_BIN === undefined
    ? fileURLToPath(new URL('../dist/bin.js', import.meta.url))
    : resolve(process.env.DSHPACK_E2E_BIN);

const children = new Set<ChildProcess>();
const homes = new Set<string>();

interface OutputObserver {
  firstLine: Promise<string>;
  stderr(): string;
  stdout(): string;
}

function observeOutput(child: ChildProcess): OutputObserver {
  let stdout = '';
  let stderr = '';
  const firstLine = new Promise<string>((resolveLine, reject) => {
    if (child.stdout === null || child.stderr === null) {
      reject(new Error('ui child stdout and stderr must be piped'));
      return;
    }
    const timeout = setTimeout(() => reject(new Error(`ui startup timed out: ${stderr}`)), 15_000);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timeout);
      resolveLine(stdout.slice(0, newline));
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`ui exited before startup: code=${code} signal=${signal} stderr=${stderr}`));
    });
  });
  return {
    firstLine,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('ui did not stop after SIGTERM')), 15_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

function expectPortClosed(port: number): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`port ${port} is still accepting connections`));
    });
    socket.once('error', () => resolveClosed());
  });
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await Promise.all([...homes].map((home) => rm(home, { force: true, recursive: true })));
  children.clear();
  homes.clear();
});

describe('dshpack ui', () => {
  it('prints a token URL on an ephemeral port and releases the socket after SIGTERM', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshpack-ui-e2e-'));
    homes.add(home);
    const child = spawn(
      process.execPath,
      [binPath, 'ui', '--port', '0', '--no-open', '--dsh-home', home],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.add(child);

    const output = observeOutput(child);
    const line = await output.firstLine;
    const url = new URL(line);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).not.toBe('0');
    expect(url.searchParams.get('token')).toBeTruthy();

    const exited = waitForExit(child);
    expect(child.kill('SIGTERM')).toBe(true);
    await exited;
    await expectPortClosed(Number(url.port));
  });

  it('keeps JSON stdout to one object for the full server lifetime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dshpack-ui-json-e2e-'));
    homes.add(home);
    const child = spawn(
      process.execPath,
      [binPath, '--json', '--dsh-home', home, 'ui', '--port', '0', '--no-open'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.add(child);
    const output = observeOutput(child);

    const report = JSON.parse(await output.firstLine) as Record<string, unknown>;
    expect(report).toMatchObject({
      diagnostics: [],
      port: expect.any(Number),
      token: expect.any(String),
      url: expect.any(String),
    });
    const exited = waitForExit(child);
    expect(child.kill('SIGTERM')).toBe(true);
    await exited;

    expect(output.stderr()).toBe('');
    expect(output.stdout().trim().split(/\r?\n/u)).toHaveLength(1);
  });
});
