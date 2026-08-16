import { resolve } from 'node:path';

import type { Command } from 'commander';

import { generateAndWriteLock } from '../lock/engine.js';
import { writeReport } from './shared.js';

export const lockCommand = {
  name: 'lock',
  description: '为手写 pack 生成或更新确定性的 pack.lock.yml',
} as const;

export function registerLockCommand(program: Command): void {
  program
    .command('lock [directory]')
    .description(lockCommand.description)
    .option('--json', 'stdout only emits one JSON object')
    .action(async (directory = '.', options: { json?: boolean }) => {
      const report = await generateAndWriteLock(resolve(directory));
      writeReport(
        report,
        options.json === true || program.opts<{ json?: boolean }>().json === true,
      );
    });
}
