import { isCancel, text } from '@clack/prompts';
import type { Command } from 'commander';
import { EXIT_CODES } from '../exit-codes.js';
import { exportProfile } from '../export/engine.js';
import {
  type InitInput,
  type InitReport,
  type InitTemplate,
  initializePack,
} from '../init/engine.js';
import { diagnostic, resolveDshHome, writeReport } from './shared.js';

export const initCommand = {
  name: 'init',
  description: '创建可立即校验和安装的本地 pack 骨架',
} as const;

interface InitOptions {
  author?: string;
  description?: string;
  fromProfile?: string;
  json?: boolean;
  license?: string;
  name?: string;
  template: InitTemplate;
  version: string;
  yes?: boolean;
}

function interactive(): boolean {
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}

function requiredInput(
  directory: string,
  options: InitOptions,
): {
  input?: InitInput;
  report?: ReturnType<typeof diagnostic>[];
} {
  const missing = (['name', 'description', 'author', 'license'] as const).filter(
    (field) => options[field] === undefined || options[field]?.trim() === '',
  );
  if (missing.length > 0) {
    const command = [
      'dshpack init',
      JSON.stringify(directory),
      `--name ${JSON.stringify(options.name ?? 'my-pack')}`,
      `--version ${JSON.stringify(options.version)}`,
      `--description ${JSON.stringify(options.description ?? 'Describe this pack')}`,
      `--author ${JSON.stringify(options.author ?? 'Your Name')}`,
      `--license ${JSON.stringify(options.license ?? 'MIT')}`,
      `--template ${options.template}`,
      '--yes',
    ].join(' ');
    return {
      report: [
        diagnostic(
          'E_INIT_REQUIRED',
          'error',
          `非交互初始化缺少必填项：${missing.join(', ')}。`,
          `直接复制运行：${command}`,
        ),
      ],
    };
  }
  return {
    input: {
      author: options.author as string,
      description: options.description as string,
      directory,
      license: options.license as string,
      name: options.name as string,
      template: options.template,
      version: options.version,
    },
  };
}

async function promptMissing(options: InitOptions): Promise<InitOptions | undefined> {
  const ask = async (label: string, initialValue: string): Promise<string | undefined> => {
    const answer = await text({ message: label, initialValue });
    return isCancel(answer) ? undefined : answer.trim();
  };
  const name = options.name ?? (await ask('Pack name', 'my-pack'));
  if (name === undefined) return undefined;
  const description = options.description ?? (await ask('Description', 'Describe this pack'));
  if (description === undefined) return undefined;
  const author = options.author ?? (await ask('Author', 'Your Name'));
  if (author === undefined) return undefined;
  const license = options.license ?? (await ask('License', 'MIT'));
  if (license === undefined) return undefined;
  return { ...options, name, description, author, license, yes: true };
}

export type InitRunner = (input: InitInput) => Promise<InitReport>;
export type ExportRunner = typeof exportProfile;

export function registerInitCommand(
  program: Command,
  run: InitRunner = initializePack,
  runExport: ExportRunner = exportProfile,
  isInteractive: () => boolean = interactive,
): void {
  program
    .command('init [directory]')
    .description(initCommand.description)
    .option('--name <name>', 'pack 名称')
    .option('--version <semver>', '版本号', '0.1.0')
    .option('--description <text>', 'pack 描述')
    .option('--author <author>', '作者')
    .option('--license <license>', '许可证')
    .option('--template <template>', 'minimal|skills|mcp|full', 'minimal')
    .option('--from-profile <name>', '委托 export 从 profile 创建')
    .option('--yes', '非交互执行')
    .option('--json', 'stdout only emits one JSON object')
    .action(async (directory = '.', options: InitOptions) => {
      const root = program.opts<{ json?: boolean }>();
      const json = options.json === true || root.json === true;
      if (options.fromProfile !== undefined) {
        const home = resolveDshHome(program);
        if (!home.ok) {
          writeReport(home.report, json);
          return;
        }
        const report = await runExport({
          dshHome: home.value,
          output: directory,
          profile: options.fromProfile,
          yes: options.yes === true,
        });
        writeReport(report, json);
        return;
      }
      if (!options.yes && isInteractive()) {
        const prompted = await promptMissing(options);
        if (prompted === undefined) {
          writeReport(
            {
              diagnostics: [
                diagnostic(
                  'E_INIT_CANCELLED',
                  'error',
                  '初始化已取消。',
                  '重新运行并完成全部提示项。',
                ),
              ],
              exitCode: EXIT_CODES.USER_DECLINED,
              metadata: { directory, template: options.template },
            },
            json,
          );
          return;
        }
        options = prompted;
      }
      const required = requiredInput(directory, options);
      if (required.report !== undefined) {
        writeReport(
          {
            diagnostics: required.report,
            exitCode: EXIT_CODES.USER_DECLINED,
            metadata: { directory, template: options.template },
          },
          json,
        );
        return;
      }
      const report = await run(required.input as InitInput);
      writeReport(report, json);
    });
}
