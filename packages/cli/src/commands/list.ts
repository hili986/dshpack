import type { Command } from 'commander';

import { type ListedProfile, type ListMetadata, listProfiles } from '../list/engine.js';
import type { CommandReport } from './shared.js';
import { writeReport } from './shared.js';

export const listCommand = {
  name: 'list',
  description: '只读列出 tracked、untracked 与 broken profiles',
} as const;

export type ListRunner = (input: { dshHome: string }) => Promise<CommandReport<ListMetadata>>;

function escapeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : character;
    })
    .join('');
}

function renderProfile(profile: ListedProfile): string {
  const name = escapeTerminalText(profile.profile);
  if (profile.status === 'tracked')
    return `${name}  tracked  ${profile.pack.name}@${profile.pack.version}`;
  if (profile.status === 'broken') return `${name}  broken  ${profile.reason}`;
  return `${name}  untracked`;
}

function showProfiles(profiles: readonly ListedProfile[]): void {
  if (profiles.length === 0) {
    process.stdout.write('未发现 profile。\n');
    return;
  }
  process.stdout.write(`${profiles.map(renderProfile).join('\n')}\n`);
}

export function registerListCommand(program: Command, run: ListRunner = listProfiles): void {
  program
    .command('list')
    .description(listCommand.description)
    .option('--json', 'stdout 仅输出一个 JSON object')
    .action(async (options: { json?: boolean }) => {
      const root = program.opts<{ dshHome?: string; json?: boolean }>();
      const report = await run({ dshHome: root.dshHome ?? process.env.DSH_HOME ?? '' });
      const json = options.json === true || root.json === true;
      writeReport(report, json);
      if (report.exitCode === 0 && !json) showProfiles(report.metadata.profiles);
    });
}
