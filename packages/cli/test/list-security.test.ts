import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerListCommand } from '../src/commands/list.js';
import { inspectMetadata } from '../src/list/contracts.js';
import {
  SHA512,
  securityHome,
  securityMarker,
  writeSecurityMarker,
} from './list-switch-security-fixture.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await securityHome('list-security');
  roots.push(value);
  return value;
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('installed metadata safety', () => {
  it('distinguishes unsafe and unreadable marker paths from a missing marker', async () => {
    const directoryHome = await root();
    await mkdir(join(directoryHome, '.dshpack', 'installed', 'demo.json'), { recursive: true });
    await expect(inspectMetadata(directoryHome, 'demo')).resolves.toMatchObject({
      status: 'broken',
    });

    const symlinkHome = await root();
    const target = join(symlinkHome, 'target-marker');
    await mkdir(target);
    await mkdir(join(symlinkHome, '.dshpack', 'installed'), { recursive: true });
    await symlink(target, join(symlinkHome, '.dshpack', 'installed', 'demo.json'), 'junction');
    await expect(inspectMetadata(symlinkHome, 'demo')).resolves.toMatchObject({
      status: 'broken',
    });

    const invalidPath = `${await root()}\0`;
    await expect(inspectMetadata(invalidPath, 'demo')).resolves.toMatchObject({ status: 'broken' });
  });

  it('requires pinned provenance, canonical digests/SemVer, and verified plugin facts', async () => {
    const home = await root();
    const validPlugin = {
      name: '@example/demo-plugin',
      packageJsonSha512: SHA512,
      bundlePatch: 'cordis.patch.yml',
      actualResolved: { version: '1.2.3' },
      actualIntegrity: { kind: 'npm-sri', value: SHA512 },
    };
    await writeSecurityMarker(home, { ...securityMarker(home), plugins: [validPlugin] });
    expect((await inspectMetadata(home, 'demo')).status).toBe('valid');
    await writeSecurityMarker(home, {
      ...securityMarker(home),
      plugins: [
        {
          ...validPlugin,
          actualIntegrity: { kind: 'unverified', reason: 'registry omitted integrity' },
        },
      ],
    });
    expect((await inspectMetadata(home, 'demo')).status).toBe('valid');

    const invalid = [
      { pack: { ...securityMarker(home).pack, manifestDigest: 'sha256-weak' } },
      { planDigest: 'sha256-weak' },
      { pack: { ...securityMarker(home).pack, version: '01.0.0' } },
      { pack: { ...securityMarker(home).pack, version: '1.0.0-01' } },
      { source: { kind: 'github', owner: 'o', repo: 'r', commit: 'main', url: 'https://x' } },
      {
        source: {
          kind: 'github',
          owner: 'o',
          repo: 'r',
          commit: 'a'.repeat(40),
          url: 'https://example.test/not-codeload',
        },
      },
      { source: { kind: 'https', url: 'http://example.test/pack.tgz', integrity: SHA512 } },
      { source: { kind: 'https', url: 'https://example.test/pack.tgz', integrity: 'sha512-x' } },
      { plugins: [{ ...validPlugin, packageJsonSha512: 'sha512-x' }] },
      { plugins: [{ ...validPlugin, name: '@BAD/plugin' }] },
      { plugins: [{ ...validPlugin, bundlePatch: '../escape.yml' }] },
      { plugins: [{ ...validPlugin, actualResolved: { commit: 'main' } }] },
      { plugins: [{ ...validPlugin, actualIntegrity: { kind: 'unverified', reason: '' } }] },
      {
        plugins: [
          {
            ...validPlugin,
            actualResolved: { commit: 'a'.repeat(40) },
            actualIntegrity: { kind: 'git-commit', value: 'b'.repeat(40) },
          },
        ],
      },
      { plugins: [{ ...validPlugin, extra: true }] },
    ];
    for (const mutation of invalid) {
      await writeSecurityMarker(home, { ...securityMarker(home), ...mutation });
      expect((await inspectMetadata(home, 'demo')).status).toBe('broken');
    }
  });
});

describe('human list terminal safety', () => {
  it('escapes control and Unicode format characters from untrusted basenames', async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const run = vi.fn(async () => ({
      diagnostics: [],
      exitCode: 0 as const,
      metadata: {
        profiles: [
          {
            profile: 'bad\n\u001b[31m\u0085\u202ename\u2066\u200d',
            status: 'broken' as const,
            reason: 'unsafe',
          },
        ],
      },
    }));
    const program = new Command().option('--dsh-home <path>').option('--json');
    registerListCommand(program, run);
    await program.parseAsync(['node', 'dshpack', '--dsh-home', process.cwd(), 'list']);
    const rendered = stdout.join('');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('bad\n');
    expect(rendered).not.toContain('\u202e');
    expect(rendered).not.toContain('\u2066');
    expect(rendered).toContain('bad\\u000a\\u001b[31m\\u0085\\u202ename\\u2066\\u200d');
  });
});
