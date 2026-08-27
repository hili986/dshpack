import { lstat, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { writeFileAtomic } from '../adapters/fs.js';
import type { CommandReport } from '../commands/shared.js';
import { diagnostic } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import { isInstallableProfileName } from '../metadata/contracts.js';
import type { UiEditSkillInput, UiSkillContentInput } from './wire.js';

export const MAX_SKILL_CONTENT_BYTES = 256 * 1024;

/** A skill id names a single dsh skill directory; it is never a path supplied by the browser. */
export function isSafeSkillId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

export interface UiSkillTarget {
  readonly directory: string;
  readonly root: string;
  readonly target: string;
}

function pathInside(root: string, target: string): boolean {
  return target.startsWith(`${root}${sep}`);
}

/** Resolve a server-owned target and prove the lexical result remains in the global skills root. */
export function resolveSkillTarget(dshHome: string, skillId: string): UiSkillTarget | undefined {
  const root = resolve(dshHome, 'skills');
  const directory = resolve(root, skillId);
  const target = resolve(directory, 'SKILL.md');
  if (!pathInside(root, directory) || !pathInside(root, target)) return undefined;
  return { root, directory, target };
}

function failure(
  code: string,
  message: string,
  metadata: Record<string, unknown> = {},
): CommandReport<object> {
  return {
    diagnostics: [diagnostic(code, 'error', message, 'Correct the request and retry.')],
    exitCode: EXIT_CODES.CONTRACT,
    metadata,
  };
}

async function safeExistingTarget(target: UiSkillTarget): Promise<'absent' | 'present' | 'unsafe'> {
  try {
    const directory = await lstat(target.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return 'unsafe';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  try {
    const file = await lstat(target.target);
    return file.isFile() && !file.isSymbolicLink() ? 'present' : 'unsafe';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
}

function targetFor(
  dshHome: string,
  input: UiSkillContentInput,
): UiSkillTarget | CommandReport<object> {
  if (!isInstallableProfileName(input.profile))
    return failure('E_UI_SKILL_PROFILE', 'The skill request has an invalid profile name.');
  if (!isSafeSkillId(input.skillId))
    return failure('E_UI_SKILL_PATH', 'The skill id is not a confined skill identifier.');
  const target = resolveSkillTarget(dshHome, input.skillId);
  return target ?? failure('E_UI_SKILL_PATH', 'The skill id is not a confined skill identifier.');
}

function plan(input: UiEditSkillInput, before: string | undefined) {
  return {
    operation: 'editSkill',
    profile: input.profile,
    skillId: input.skillId,
    target: `skills/${input.skillId}/SKILL.md`,
    action: before === undefined ? 'create' : 'replace',
    beforeBytes: before === undefined ? 0 : Buffer.byteLength(before, 'utf8'),
    afterBytes: Buffer.byteLength(input.content, 'utf8'),
  };
}

/** Read raw SKILL.md bytes only after resolving a fixed, confined server-owned target. */
export async function readSkillContent(
  dshHome: string,
  input: UiSkillContentInput,
): Promise<CommandReport<object>> {
  const selected = targetFor(dshHome, input);
  if ('exitCode' in selected) return selected;
  const state = await safeExistingTarget(selected);
  if (state === 'unsafe')
    return failure('E_UI_SKILL_PATH', 'The requested skill target is not a regular confined file.');
  if (state === 'absent')
    return failure(
      'E_UI_SKILL_MISSING',
      'The requested skill does not exist in the selected profile.',
    );
  const content = await readFile(selected.target, 'utf8');
  return {
    diagnostics: [],
    exitCode: EXIT_CODES.SUCCESS,
    metadata: {
      profile: input.profile,
      skillId: input.skillId,
      target: `skills/${input.skillId}/SKILL.md`,
      content,
    },
  };
}

/** Plan or write user-owned skill bytes; metadata is deliberately never rewritten as pack state. */
export async function editSkillContent(
  dshHome: string,
  input: UiEditSkillInput,
  phase: 'plan' | 'apply',
): Promise<CommandReport<object>> {
  if (Buffer.byteLength(input.content, 'utf8') > MAX_SKILL_CONTENT_BYTES)
    return failure(
      'E_UI_SKILL_CONTENT_TOO_LARGE',
      `Skill content exceeds the ${String(MAX_SKILL_CONTENT_BYTES)} byte limit.`,
    );
  const selected = targetFor(dshHome, input);
  if ('exitCode' in selected) return selected;
  const state = await safeExistingTarget(selected);
  if (state === 'unsafe')
    return failure('E_UI_SKILL_PATH', 'The requested skill target is not a regular confined file.');
  const before = state === 'present' ? await readFile(selected.target, 'utf8') : undefined;
  const editPlan = plan(input, before);
  if (phase === 'plan')
    return { diagnostics: [], exitCode: EXIT_CODES.SUCCESS, metadata: { plan: editPlan } };
  await writeFileAtomic(selected.target, input.content, { mode: 0o600, dirMode: 0o700 });
  return {
    diagnostics: [],
    exitCode: EXIT_CODES.SUCCESS,
    metadata: { plan: editPlan, status: 'edited', userOwned: true },
  };
}
