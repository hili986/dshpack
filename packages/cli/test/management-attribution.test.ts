import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { diagnostic } from '../src/commands/shared.js';
import { attributableToInstall, type InstallOwnership } from '../src/management/attribution.js';

const dshHome = 'C:/dsh-home';
const ownership: InstallOwnership = {
  profile: 'demo-pack',
  assets: [
    { target: 'skills/notes', action: 'create' },
    { target: '.agent-presets/research', action: 'replace' },
    { target: 'skills/already-there', action: 'skip' },
  ],
};

describe('install diagnostic attribution', () => {
  it.each([
    [undefined, true],
    [join(dshHome, 'profiles', 'demo-pack', 'package.json'), true],
    [join(dshHome, 'settings.yaml'), true],
    [join(dshHome, 'skills', 'notes', 'SKILL.md'), true],
    [join(dshHome, '.agent-presets', 'research', 'agent.cordis.yml'), true],
    [join(dshHome, 'skills', 'already-there', 'SKILL.md'), false],
    [join(dshHome, 'skills', 'notes-old', 'SKILL.md'), false],
    [join(dshHome, 'skills', 'someone-else', 'SKILL.md'), false],
  ] as const)('attributes %s as %s', (path, expected) => {
    expect(
      attributableToInstall(
        diagnostic('DSH010', 'error', 'finding', 'fix', path),
        dshHome,
        ownership,
      ),
    ).toBe(expected);
  });
});
