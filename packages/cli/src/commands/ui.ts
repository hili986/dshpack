import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';

import { startUiServer } from '../ui/server.js';
import { resolveDshHome, writeReport } from './shared.js';

export const uiCommand = {
  name: 'ui',
  description: '启动只监听本机的 dshpack 管理界面',
} as const;

export interface UiCommandServerOptions {
  dshHome: string;
  port: number;
}

export interface UiCommandServerHandle {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

export type UiServerStarter = (options: UiCommandServerOptions) => Promise<UiCommandServerHandle>;
export type UiBrowserOpener = (url: string) => Promise<void>;
export type UiShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface UiSignalRuntime {
  once(signal: UiShutdownSignal, listener: () => void): unknown;
  off(signal: UiShutdownSignal, listener: () => void): unknown;
}

export interface UiCommandDependencies {
  startServer: UiServerStarter;
  openBrowser: UiBrowserOpener;
  signals: UiSignalRuntime;
}

export interface UiBrowserChild {
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'spawn', listener: () => void): unknown;
  unref(): void;
}

export interface UiBrowserRuntime {
  platform: NodeJS.Platform;
  spawn(
    command: string,
    args: string[],
    options: { detached: true; stdio: 'ignore' },
  ): UiBrowserChild;
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError('端口必须是 0 到 65535 之间的整数。');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new InvalidArgumentError('端口必须是 0 到 65535 之间的整数。');
  }
  return port;
}

interface UiShutdownWaiter {
  dispose(): void;
  signal: Promise<UiShutdownSignal>;
}

function waitForShutdown(signals: UiSignalRuntime): UiShutdownWaiter {
  let dispose!: () => void;
  const signal = new Promise<UiShutdownSignal>((resolve) => {
    const onSigint = () => finish('SIGINT');
    const onSigterm = () => finish('SIGTERM');
    const finish = (signal: UiShutdownSignal) => {
      resolve(signal);
    };
    dispose = () => {
      signals.off('SIGINT', onSigint);
      signals.off('SIGTERM', onSigterm);
    };
    signals.once('SIGINT', onSigint);
    signals.once('SIGTERM', onSigterm);
  });
  return { dispose, signal };
}

const nodeBrowserRuntime: UiBrowserRuntime = {
  platform: process.platform,
  spawn,
};

export function openUiBrowser(
  url: string,
  runtime: UiBrowserRuntime = nodeBrowserRuntime,
): Promise<void> {
  const [command, args] =
    runtime.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : runtime.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  return new Promise((resolve, reject) => {
    const child = runtime.spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const defaultDependencies: UiCommandDependencies = {
  startServer: startUiServer,
  openBrowser: openUiBrowser,
  signals: process,
};

export function registerUiCommand(
  program: Command,
  dependencies: UiCommandDependencies = defaultDependencies,
): void {
  program
    .command('ui')
    .description(uiCommand.description)
    .option('--port <port>', '监听端口；0 表示由操作系统分配', parsePort, 0)
    .option('--no-open', '不自动打开浏览器')
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(async (options: { json?: boolean; open: boolean; port: number }) => {
      const root = program.opts<{ json?: boolean }>();
      const json = options.json === true || root.json === true;
      const home = resolveDshHome(program);
      if (!home.ok) {
        writeReport(home.report, json);
        return;
      }

      const shutdown = waitForShutdown(dependencies.signals);
      let handle: UiCommandServerHandle | undefined;
      try {
        handle = await dependencies.startServer({ dshHome: home.value, port: options.port });
        if (json) {
          writeReport(
            {
              diagnostics: [],
              exitCode: 0,
              metadata: { url: handle.url, token: handle.token, port: handle.port },
            },
            true,
          );
        } else {
          process.stdout.write(`${handle.url}\n`);
        }

        if (options.open) await dependencies.openBrowser(handle.url);
        await shutdown.signal;
      } finally {
        shutdown.dispose();
        await handle?.close();
      }
    });
}
