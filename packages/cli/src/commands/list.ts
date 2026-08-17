import type { Command } from 'commander';

import { type ListedProfile, type ListMetadata, listProfiles } from '../list/engine.js';
import type { CommandReport } from './shared.js';
import { resolveDshHome, writeReport } from './shared.js';

export const listCommand = {
  name: 'list',
  description: '只读列出 tracked、untracked、reserved 与 broken profiles',
} as const;

export type ListRunner = (input: { dshHome: string }) => Promise<CommandReport<ListMetadata>>;

function escapeTerminalText(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const unsafe = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character);
      if (!unsafe) return character;
      return code <= 0xffff
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : `\\u{${code.toString(16)}}`;
    })
    .join('');
}

function renderProfile(profile: ListedProfile): string {
  const name = escapeTerminalText(profile.profile);
  if (profile.status === 'tracked')
    return `${name}  tracked  ${profile.pack.name}@${profile.pack.version}`;
  if (profile.status === 'broken') return `${name}  broken  ${profile.reason}`;
  if (profile.status === 'reserved') return `${name}  reserved  ${profile.reason}`;
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
      const json = options.json === true || root.json === true;
      const home = resolveDshHome(program);
      if (!home.ok) {
        writeReport(home.report, json);
        return;
      }
      const report = await run({ dshHome: home.value });
      writeReport(report, json);
      if (report.exitCode === 0 && !json) showProfiles(report.metadata.profiles);
    });
}
