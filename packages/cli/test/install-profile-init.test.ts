import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { InstallProfileError, validateOfficialProfileInit } from '../src/install/profile-init.js';
import {
  buildAuthorizationKey,
  updateWorkspaceAllowBuilds,
} from '../src/install/profile-workspace.js';

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-profile-init-'));
  roots.push(root);
  return root;
}

async function officialProfile(root: string, name = 'demo'): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })}\n`,
  );
  await writeFile(
    join(root, 'cordis.patch.yml'),
    '# Your patch layer for this dsh profile, applied after every bundle layer:\n' +
      '# a top-level YAML array of loader patch entries.\n[]\n',
  );
  await writeFile(
    join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('official profile initialization contract (E1)', () => {
  it('accepts exactly the three official files and returns parsed facts', async () => {
    const root = await temporary();
    await officialProfile(root);

    await expect(validateOfficialProfileInit(root, 'demo')).resolves.toEqual({
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: {},
      packageName: 'dsh-profile-demo',
    });
  });

  it.each(['pnpm-lock.yaml', 'cordis.yml', 'unexpected.txt'])(
    'rejects an unexpected initial file: %s',
    async (file) => {
      const root = await temporary();
      await officialProfile(root);
      await writeFile(join(root, file), 'unexpected');

      await expect(validateOfficialProfileInit(root, 'demo')).rejects.toMatchObject({
        code: 'E_PROFILE_INIT_FILES',
      });
    },
  );

  it.each([
    ['name', { name: 'dsh-profile-other' }],
    ['private', { private: false }],
    ['dependencies', { dependencies: { leaked: '1.0.0' } }],
    ['bundles', { dsh: { profile: { bundles: [] } } }],
    ['shape', { scripts: {} }],
  ])('rejects a package.json %s drift', async (_label, override) => {
    const root = await temporary();
    await officialProfile(root);
    const base = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as object;
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...base, ...override }));

    await expect(validateOfficialProfileInit(root, 'demo')).rejects.toBeInstanceOf(
      InstallProfileError,
    );
  });

  it('rejects malformed JSON, YAML drift, a non-array patch, and a symlink', async () => {
    const malformed = await temporary();
    await officialProfile(malformed);
    await writeFile(join(malformed, 'package.json'), '{');
    await expect(validateOfficialProfileInit(malformed, 'demo')).rejects.toMatchObject({
      code: 'E_PROFILE_INIT_PACKAGE',
    });

    const workspace = await temporary();
    await officialProfile(workspace);
    await writeFile(
      join(workspace, 'pnpm-workspace.yaml'),
      'packages: [.]\nnodeLinker: isolated\n',
    );
    await expect(validateOfficialProfileInit(workspace, 'demo')).rejects.toMatchObject({
      code: 'E_PROFILE_INIT_WORKSPACE',
    });

    const patch = await temporary();
    await officialProfile(patch);
    await writeFile(join(patch, 'cordis.patch.yml'), '{}\n');
    await expect(validateOfficialProfileInit(patch, 'demo')).rejects.toMatchObject({
      code: 'E_PROFILE_INIT_PATCH',
    });

    const linked = await temporary();
    const target = await temporary();
    await officialProfile(linked);
    await mkdir(join(target, 'package.json'));
    await rm(join(linked, 'package.json'));
    await symlink(join(target, 'package.json'), join(linked, 'package.json'), 'junction');
    await expect(validateOfficialProfileInit(linked, 'demo')).rejects.toMatchObject({
      code: 'E_PROFILE_INIT_FILE_TYPE',
    });
  });
});

describe('workspace allowBuilds RMW', () => {
  const npmPlugin = {
    name: '@scope/plugin',
    source: { kind: 'npm' as const, range: '^1.0.0' },
    allowBuilds: true,
  };
  const gitPlugin = {
    name: 'git-plugin',
    source: {
      kind: 'github' as const,
      owner: 'owner',
      repo: 'repo',
      ref: 'a'.repeat(40),
    },
    allowBuilds: true,
  };

  it('adds only the exact direct key and preserves comments and other keys', () => {
    const source =
      '# keep\npackages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nother: value\nallowBuilds:\n  existing: false\n';
    const output = updateWorkspaceAllowBuilds(source, npmPlugin);

    expect(output).toContain('# keep');
    expect(output).toContain('other: value');
    expect(output).toContain('existing: false');
    expect(parse(output).allowBuilds).toMatchObject({ '@scope/plugin': true });
    expect(output).not.toContain('@scope/*');
  });

  it('derives the exact GitHub authorization key used by pnpm', () => {
    expect(buildAuthorizationKey(gitPlugin)).toBe(
      'git-plugin@git+https://github.com/owner/repo.git',
    );
    expect(updateWorkspaceAllowBuilds("packages: ['.']\n", gitPlugin)).toContain(
      'git-plugin@git+https://github.com/owner/repo.git: true',
    );
  });

  it('is idempotent and supports tarball/name keys without widening', () => {
    const once = updateWorkspaceAllowBuilds("packages: ['.']\n", npmPlugin);
    expect(updateWorkspaceAllowBuilds(once, npmPlugin)).toBe(once);
    expect(
      buildAuthorizationKey({
        name: 'tar-plugin',
        source: { kind: 'tarball', url: 'https://example.test/p.tgz' },
        allowBuilds: true,
      }),
    ).toBe('tar-plugin');
  });

  it.each([
    ['malformed YAML', 'packages: [\n'],
    ['non-mapping root', '[]\n'],
    ['non-mapping allowBuilds', 'allowBuilds: true\n'],
    ['non-boolean existing authorization', 'allowBuilds:\n  bad: maybe\n'],
    ['duplicate key', 'allowBuilds: {}\nallowBuilds: {}\n'],
  ])('fails closed for %s', (_label, source) => {
    expect(() => updateWorkspaceAllowBuilds(source, npmPlugin)).toThrow(InstallProfileError);
  });

  it('rejects invalid package/source identifiers instead of constructing a broad key', () => {
    try {
      buildAuthorizationKey({ ...npmPlugin, name: '../bad' });
      expect.unreachable('unsafe package name should fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'E_PLUGIN_NAME' });
    }
    try {
      buildAuthorizationKey({
        ...gitPlugin,
        source: { ...gitPlugin.source, owner: 'bad/name' },
      });
      expect.unreachable('unsafe GitHub owner should fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'E_PLUGIN_SOURCE' });
    }
  });
});
