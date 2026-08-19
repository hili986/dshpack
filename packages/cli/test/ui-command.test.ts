import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_NAMES, runCli } from '../src/cli.js';
import {
  openUiBrowser,
  registerUiCommand,
  type UiBrowserChild,
  type UiCommandDependencies,
  type UiCommandServerHandle,
  type UiShutdownSignal,
} from '../src/commands/ui.js';

const DSH_HOME = resolve('/ui-command-home');
const URL = 'http://127.0.0.1:43123/?token=test-token';

class SignalRuntime extends EventEmitter {
  override once(signal: UiShutdownSignal, listener: () => void): this {
    return super.once(signal, listener);
  }

  override off(signal: UiShutdownSignal, listener: () => void): this {
    return super.off(signal, listener);
  }
}

function program(): Command {
  return new Command()
    .name('dshpack')
    .exitOverride()
    .option('--dsh-home <path>')
    .option('--no-color')
    .option('--quiet')
    .option('--json');
}

function setup(overrides: Partial<UiCommandDependencies> = {}) {
  const signals = new SignalRuntime();
  const close = vi.fn(async () => undefined);
  const handle: UiCommandServerHandle = {
    url: URL,
    token: 'test-token',
    port: 43_123,
    close,
  };
  const startServer = vi.fn(async () => handle);
  const openBrowser = vi.fn(async () => undefined);
  const dependencies: UiCommandDependencies = {
    signals,
    startServer,
    openBrowser,
    ...overrides,
  };
  const cli = program();
  registerUiCommand(cli, dependencies);
  return { cli, close, handle, openBrowser, signals, startServer };
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stderr, stdout };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolveNow) => setImmediate(resolveNow));
}

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ui command', () => {
  it('defaults to an ephemeral port, prints the token URL, opens it, and closes on SIGINT', async () => {
    const io = capture();
    const context = setup();
    const running = context.cli.parseAsync(['node', 'dshpack', '--dsh-home', DSH_HOME, 'ui']);
    await flush();

    expect(context.startServer).toHaveBeenCalledWith({ dshHome: DSH_HOME, port: 0 });
    expect(context.openBrowser).toHaveBeenCalledWith(URL);
    expect(io.stdout).toEqual([`${URL}\n`]);
    expect(io.stderr).toEqual([]);

    context.signals.emit('SIGINT');
    await running;
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.signals.listenerCount('SIGINT')).toBe(0);
    expect(context.signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('accepts a fixed port and --no-open, then closes exactly once on SIGTERM', async () => {
    capture();
    const context = setup();
    const running = context.cli.parseAsync([
      'node',
      'dshpack',
      'ui',
      '--port',
      '8080',
      '--no-open',
      '--dsh-home',
      DSH_HOME,
      '--no-color',
    ]);
    await flush();

    expect(context.startServer).toHaveBeenCalledWith({ dshHome: DSH_HOME, port: 8080 });
    expect(context.openBrowser).not.toHaveBeenCalled();
    context.signals.emit('SIGTERM');
    context.signals.emit('SIGINT');
    await running;
    expect(context.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['root', ['--json', '--dsh-home', DSH_HOME, 'ui', '--no-open']],
    ['child', ['--dsh-home', DSH_HOME, 'ui', '--json', '--no-open']],
  ] as const)('writes exactly one JSON object for %s --json', async (_placement, args) => {
    const io = capture();
    const context = setup();
    const running = context.cli.parseAsync(['node', 'dshpack', ...args]);
    await flush();

    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0] ?? '{}')).toEqual({
      diagnostics: [],
      url: URL,
      token: 'test-token',
      port: 43_123,
    });
    context.signals.emit('SIGINT');
    await running;
    expect(io.stdout).toHaveLength(1);
  });

  it('keeps the token URL as the one necessary line under root --quiet', async () => {
    const io = capture();
    const context = setup();
    const running = context.cli.parseAsync([
      'node',
      'dshpack',
      'ui',
      '--quiet',
      '--no-open',
      '--dsh-home',
      DSH_HOME,
    ]);
    await flush();

    expect(io.stdout).toEqual([`${URL}\n`]);
    expect(context.startServer).toHaveBeenCalledOnce();
    context.signals.emit('SIGINT');
    await running;
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('rejects invalid ports before starting the server', async () => {
    capture();
    for (const port of ['-1', '1.5', '65536', 'NaN']) {
      const context = setup();
      await expect(
        context.cli.parseAsync(['node', 'dshpack', '--dsh-home', DSH_HOME, 'ui', '--port', port]),
      ).rejects.toMatchObject({ code: 'commander.invalidArgument' });
      expect(context.startServer).not.toHaveBeenCalled();
    }
  });

  it('rejects a missing DSH_HOME before starting and closes after browser launch failure', async () => {
    const io = capture();
    vi.stubEnv('DSH_HOME', '');
    const missing = setup();
    await missing.cli.parseAsync(['node', 'dshpack', 'ui', '--json']);
    expect(missing.startServer).not.toHaveBeenCalled();
    expect(JSON.parse(io.stdout[0] ?? '{}')).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_DSH_HOME_REQUIRED' })],
    });

    const failure = new Error('browser unavailable');
    const launchFailure = setup({ openBrowser: vi.fn(async () => Promise.reject(failure)) });
    await expect(
      launchFailure.cli.parseAsync(['node', 'dshpack', '--dsh-home', DSH_HOME, 'ui']),
    ).rejects.toBe(failure);
    expect(launchFailure.close).toHaveBeenCalledOnce();
  });

  it('removes both signal listeners when server startup fails', async () => {
    const failure = new Error('listen failed');
    const context = setup({ startServer: vi.fn(async () => Promise.reject(failure)) });

    await expect(
      context.cli.parseAsync(['node', 'dshpack', '--dsh-home', DSH_HOME, 'ui', '--no-open']),
    ).rejects.toBe(failure);
    expect(context.signals.listenerCount('SIGINT')).toBe(0);
    expect(context.signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('registers ui in the root version guard without starting a server', async () => {
    const io = capture();
    expect(COMMAND_NAMES).toContain('ui');
    await runCli(['node', 'dshpack', 'ui', '--version']);
    expect(process.exitCode).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('')).toContain('E_USAGE');
  });
});

describe('ui browser opener', () => {
  it.each([
    ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', URL]],
    ['darwin', 'open', [URL]],
    ['linux', 'xdg-open', [URL]],
  ] as const)(
    'uses the platform launcher on %s and detaches it',
    async (platform, command, args) => {
      const child = new EventEmitter() as EventEmitter & UiBrowserChild;
      child.unref = vi.fn();
      const spawn = vi.fn(() => child);
      const opening = openUiBrowser(URL, { platform, spawn });

      child.emit('spawn');
      await opening;
      expect(spawn).toHaveBeenCalledWith(command, args, { detached: true, stdio: 'ignore' });
      expect(child.unref).toHaveBeenCalledOnce();
    },
  );

  it('rejects a launcher error without detaching a failed child', async () => {
    const child = new EventEmitter() as EventEmitter & UiBrowserChild;
    child.unref = vi.fn();
    const failure = new Error('launcher missing');
    const opening = openUiBrowser(URL, { platform: 'linux', spawn: () => child });

    child.emit('error', failure);
    await expect(opening).rejects.toBe(failure);
    expect(child.unref).not.toHaveBeenCalled();
  });
});
