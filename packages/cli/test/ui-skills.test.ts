import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, lstat: vi.fn(original.lstat) };
});

import { diffProfile } from '../src/diff/engine.js';
import { EXIT_CODES } from '../src/exit-codes.js';
import { installPack } from '../src/install/engine.js';
import {
  editSkillContent,
  isSafeSkillId,
  MAX_SKILL_CONTENT_BYTES,
  readSkillContent,
  resolveSkillTarget,
} from '../src/ui/skills.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-skills-'));
  roots.push(root);
  await mkdir(join(root, 'skills', 'notes'), { recursive: true });
  await writeFile(join(root, 'skills', 'notes', 'SKILL.md'), '# Original notes\n');
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('UI skill content path closure', () => {
  it('reads only a server-built SKILL.md path and plans byte changes before an edit', async () => {
    const dshHome = await fixture();
    const input = { profile: 'notes-profile', skillId: 'notes' } as const;

    const content = await readSkillContent(dshHome, input);
    expect(content).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { content: '# Original notes\n', target: 'skills/notes/SKILL.md' },
    });

    const planned = await editSkillContent(
      dshHome,
      { ...input, content: '# User notes\n' },
      'plan',
    );
    expect(planned).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        plan: {
          action: 'replace',
          beforeBytes: Buffer.byteLength('# Original notes\n'),
          afterBytes: Buffer.byteLength('# User notes\n'),
          target: 'skills/notes/SKILL.md',
        },
      },
    });
    expect(await readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe(
      '# Original notes\n',
    );

    const applied = await editSkillContent(
      dshHome,
      { ...input, content: '# User notes\n' },
      'apply',
    );
    expect(applied).toMatchObject({ exitCode: EXIT_CODES.SUCCESS, metadata: { userOwned: true } });
    expect(await readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe(
      '# User notes\n',
    );
  });

  it('rejects traversal-shaped ids, resolve escapes, and oversized content before a write', async () => {
    const dshHome = await fixture();
    const profile = 'notes-profile';
    for (const skillId of ['..', '../notes', 'notes/child', 'notes\\child']) {
      const denied = await readSkillContent(dshHome, { profile, skillId });
      expect(denied).toMatchObject({
        exitCode: EXIT_CODES.CONTRACT,
        diagnostics: [expect.objectContaining({ code: 'E_UI_SKILL_PATH' })],
      });
    }
    // Pin the lexical confinement check independently of the id regex; a mutant that lets `..`
    // through still cannot turn the server-built target into an outside path.
    expect(resolveSkillTarget(resolve('/name'), '..')).toBeUndefined();

    const tooLarge = await editSkillContent(
      dshHome,
      { profile, skillId: 'notes', content: 'x'.repeat(MAX_SKILL_CONTENT_BYTES + 1) },
      'plan',
    );
    expect(tooLarge).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_UI_SKILL_CONTENT_TOO_LARGE' })],
    });
    expect(await readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe(
      '# Original notes\n',
    );
  });

  it('plans an absent target as a user-owned creation without accepting a browser path', async () => {
    const dshHome = await fixture();
    const planned = await editSkillContent(
      dshHome,
      { profile: 'notes-profile', skillId: 'new-skill', content: '# New skill\n' },
      'plan',
    );

    expect(planned).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { plan: { action: 'create', beforeBytes: 0, afterBytes: 12 } },
    });
  });

  it('fails closed for invalid profiles and non-regular skill filesystem entries', async () => {
    const dshHome = await fixture();
    expect(isSafeSkillId('notes')).toBe(true);
    expect(isSafeSkillId('..')).toBe(false);
    for (const value of [undefined, '', 'UPPER', '..', 'notes/path'])
      expect(isSafeSkillId(value)).toBe(false);

    // 'no' became installable when M3.5 lowered the --as floor to 1; '-no' still fails the
    // shape rule, which is what this assertion nails (E_UI_SKILL_PROFILE on bad shape).
    const invalidProfile = await readSkillContent(dshHome, { profile: '-no', skillId: 'notes' });
    expect(invalidProfile).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_UI_SKILL_PROFILE' })],
    });
    const absent = await readSkillContent(dshHome, { profile: 'notes-profile', skillId: 'absent' });
    expect(absent).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_UI_SKILL_MISSING' })],
    });
    await mkdir(join(dshHome, 'skills', 'empty-skill'), { recursive: true });
    const missingFile = await readSkillContent(dshHome, {
      profile: 'notes-profile',
      skillId: 'empty-skill',
    });
    expect(missingFile).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_UI_SKILL_MISSING' })],
    });

    await writeFile(join(dshHome, 'skills', 'not-a-directory'), 'outside');
    const directoryUnsafe = await readSkillContent(dshHome, {
      profile: 'notes-profile',
      skillId: 'not-a-directory',
    });
    expect(directoryUnsafe).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_UI_SKILL_PATH' })],
    });

    await mkdir(join(dshHome, 'skills', 'not-a-file', 'SKILL.md'), { recursive: true });
    const fileUnsafe = await editSkillContent(
      dshHome,
      { profile: 'notes-profile', skillId: 'not-a-file', content: '# blocked\n' },
      'plan',
    );
    expect(fileUnsafe).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'E_UI_SKILL_PATH' })],
    });
  });

  it('does not reinterpret unexpected storage errors as an absent skill and rejects invalid edit profiles', async () => {
    const dshHome = await fixture();
    const denied = Object.assign(new Error('storage access denied'), { code: 'EACCES' });
    vi.mocked(lstat).mockRejectedValueOnce(denied);
    await expect(
      readSkillContent(dshHome, { profile: 'notes-profile', skillId: 'notes' }),
    ).rejects.toBe(denied);

    const invalidEdit = await editSkillContent(
      dshHome,
      { profile: '-invalid', skillId: 'notes', content: '# unchanged\n' },
      'plan',
    );
    expect(invalidEdit).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_UI_SKILL_PROFILE' })],
    });
  });

  it('leaves saved bytes outside pack ownership so the selected profile immediately reports drift', async () => {
    const dshHome = await fixture();
    await rm(join(dshHome, 'skills'), { recursive: true, force: true });
    const source = await enginePack({ assets: true });
    const runtime = fakeRuntime({ confirmations: [true] }).runtime;
    const installed = await installPack(
      { dshHome, source, as: 'notes-profile', interactive: true, yes: true },
      runtime,
    );
    expect(installed.exitCode).toBe(EXIT_CODES.SUCCESS);

    const edited = await editSkillContent(
      dshHome,
      { profile: 'notes-profile', skillId: 'notes', content: '# user-owned notes\n' },
      'apply',
    );
    expect(edited).toMatchObject({ exitCode: EXIT_CODES.SUCCESS, metadata: { userOwned: true } });

    const diff = await diffProfile({ dshHome, profile: 'notes-profile' }, runtime);
    expect(diff).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        localDrift: [expect.objectContaining({ kind: 'skill', target: 'skills/notes' })],
      },
    });
  });
});
