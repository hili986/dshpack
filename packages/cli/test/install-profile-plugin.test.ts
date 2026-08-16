import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackLockedPlugin, PluginDeclaration } from '@dshpack/core';
import { afterEach, describe, expect, it } from 'vitest';

import { exactPluginAddSpec, verifyInstalledPlugin } from '../src/install/profile-plugin.js';

const roots: string[] = [];
const commit = 'b07eac099753833b29d06c614149904445739776';

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-profile-plugin-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const npmDeclaration: PluginDeclaration = {
  name: 'yocto-queue',
  source: { kind: 'npm', range: '^1.2.0' },
  allowBuilds: false,
};

function npmLock(packageJsonSha512: string): PackLockedPlugin {
  return {
    name: 'yocto-queue',
    resolved: { version: '1.2.2' },
    integrity: {
      kind: 'npm-sri',
      value:
        'sha512-4LCcse/U2MHZ63HAJVE+v71o7yOdIe4cZ70Wpf8D/IyjDKYQLV5GD46B+hSTjJsvV5PztjvHoU580EftxjDZFQ==',
    },
    packageJsonSha512,
    bundlePatch: './cordis.patch.yml',
  };
}

function npmLockYaml(): string {
  return `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      yocto-queue:
        specifier: 1.2.2
        version: 1.2.2
packages:
  yocto-queue@1.2.2:
    resolution: {integrity: sha512-4LCcse/U2MHZ63HAJVE+v71o7yOdIe4cZ70Wpf8D/IyjDKYQLV5GD46B+hSTjJsvV5PztjvHoU580EftxjDZFQ==}
snapshots:
  yocto-queue@1.2.2: {}
`;
}

async function installedNpm(root: string, packageOverride: object = {}): Promise<PackLockedPlugin> {
  const packageSource = `${JSON.stringify({
    name: 'yocto-queue',
    version: '1.2.2',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...packageOverride,
  })}\n`;
  const packageRoot = join(root, 'node_modules', 'yocto-queue');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), packageSource);
  await writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-demo',
      private: true,
      dependencies: { 'yocto-queue': '1.2.2' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'yocto-queue'] } },
    }),
  );
  await writeFile(join(root, 'pnpm-lock.yaml'), npmLockYaml());
  return npmLock(sri(Buffer.from(packageSource)));
}

describe('exact dsh plugin add specs', () => {
  it('uses the locked exact npm version and pinned GitHub commit', async () => {
    const npm = npmLock('sha512-AA==');
    await expect(exactPluginAddSpec(npmDeclaration, npm)).resolves.toBe('yocto-queue@1.2.2');

    const github: PluginDeclaration = {
      name: 'git-plugin',
      source: { kind: 'github', owner: 'owner', repo: 'repo', ref: commit },
      allowBuilds: false,
    };
    const locked: PackLockedPlugin = {
      name: github.name,
      resolved: { commit },
      integrity: { kind: 'git-commit', value: commit },
      packageJsonSha512: 'sha512-AA==',
      bundlePatch: 'patch.yml',
    };
    await expect(exactPluginAddSpec(github, locked)).resolves.toBe(`github:owner/repo#${commit}`);
  });

  it('passes only an integrity-rechecked local tgz path for tarballs', async () => {
    const root = await temporary();
    const path = join(root, 'verified.tgz');
    const bytes = Buffer.from('verified tgz fixture');
    await writeFile(path, bytes);
    const integrity = sri(bytes);
    const url = 'https://example.test/plugin.tgz';
    const declaration: PluginDeclaration = {
      name: 'tar-plugin',
      source: { kind: 'tarball', url },
      allowBuilds: false,
    };
    const locked: PackLockedPlugin = {
      name: declaration.name,
      resolved: { url },
      integrity: { kind: 'sha512', value: integrity },
      packageJsonSha512: 'sha512-AA==',
      bundlePatch: 'patch.yml',
    };

    await expect(exactPluginAddSpec(declaration, locked, path)).resolves.toBe(path);
    await writeFile(path, 'mutated');
    await expect(exactPluginAddSpec(declaration, locked, path)).rejects.toMatchObject({
      code: 'E_PLUGIN_TARBALL_INTEGRITY',
    });
  });

  it('fails closed for source/lock mismatch, unpinned git, unverified tarball, and symlinks', async () => {
    const badNpm = { ...npmLock('sha512-AA=='), resolved: { version: '2.0.0' } };
    await expect(exactPluginAddSpec(npmDeclaration, badNpm)).rejects.toMatchObject({
      code: 'E_PLUGIN_LOCK_MISMATCH',
    });

    const git: PluginDeclaration = {
      name: 'git-plugin',
      source: { kind: 'github', owner: 'owner', repo: 'repo', ref: commit },
      allowBuilds: false,
    };
    const wrongCommit = 'a'.repeat(40);
    await expect(
      exactPluginAddSpec(git, {
        name: git.name,
        resolved: { commit: wrongCommit },
        integrity: { kind: 'git-commit', value: wrongCommit },
        packageJsonSha512: 'sha512-AA==',
        bundlePatch: 'patch.yml',
      }),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_LOCK_MISMATCH' });

    const root = await temporary();
    const target = join(root, 'target.tgz');
    const link = join(root, 'link.tgz');
    await writeFile(target, 'x');
    try {
      await symlink(target, link, 'file');
      const url = 'https://example.test/p.tgz';
      const tar: PluginDeclaration = {
        name: 'tar-plugin',
        source: { kind: 'tarball', url },
        allowBuilds: false,
      };
      await expect(
        exactPluginAddSpec(
          tar,
          {
            name: tar.name,
            resolved: { url },
            integrity: { kind: 'unverified', reason: 'legacy' },
            packageJsonSha512: 'sha512-AA==',
            bundlePatch: 'patch.yml',
          },
          link,
        ),
      ).rejects.toMatchObject({ code: 'E_PLUGIN_TARBALL_UNVERIFIED' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });

  it('rejects lock name/kind drift and requires an absolute ordinary staged tgz', async () => {
    await expect(
      exactPluginAddSpec(npmDeclaration, { ...npmLock('sha512-AA=='), name: 'other' }),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_LOCK_MISMATCH' });
    await expect(
      exactPluginAddSpec(npmDeclaration, {
        ...npmLock('sha512-AA=='),
        integrity: { kind: 'sha512', value: 'sha512-AA==' },
      }),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_LOCK_MISMATCH' });

    const url = 'https://example.test/p.tgz';
    const tar: PluginDeclaration = {
      name: 'tar-plugin',
      source: { kind: 'tarball', url },
      allowBuilds: false,
    };
    const locked: PackLockedPlugin = {
      name: tar.name,
      resolved: { url },
      integrity: { kind: 'sha512', value: 'sha512-AA==' },
      packageJsonSha512: 'sha512-AA==',
      bundlePatch: 'patch.yml',
    };
    await expect(exactPluginAddSpec(tar, locked)).rejects.toMatchObject({
      code: 'E_PLUGIN_TARBALL_PATH',
    });
    await expect(exactPluginAddSpec(tar, locked, 'relative.tgz')).rejects.toMatchObject({
      code: 'E_PLUGIN_TARBALL_PATH',
    });
    const root = await temporary();
    const directory = join(root, 'directory.tgz');
    await mkdir(directory);
    await expect(exactPluginAddSpec(tar, locked, directory)).rejects.toMatchObject({
      code: 'E_PLUGIN_TARBALL_PATH',
    });
    await expect(
      exactPluginAddSpec(tar, { ...locked, resolved: { url: 'https://example.test/other.tgz' } }),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_LOCK_MISMATCH' });
  });
});

describe('post-add verification', () => {
  it('reads actual package bytes and reconciles all four pnpm lock facts', async () => {
    const root = await temporary();
    const locked = await installedNpm(root);

    await expect(verifyInstalledPlugin(root, npmDeclaration, locked)).resolves.toEqual({
      actualIntegrity: locked.integrity,
      actualResolved: locked.resolved,
      bundlePatch: './cordis.patch.yml',
      packageJsonSha512: locked.packageJsonSha512,
    });
  });

  it.each([
    [
      'package hash',
      (locked: PackLockedPlugin) => ({ ...locked, packageJsonSha512: 'sha512-AA==' }),
      'E_PLUGIN_PACKAGE_HASH',
    ],
    [
      'bundle patch',
      (locked: PackLockedPlugin) => ({ ...locked, bundlePatch: 'other.yml' }),
      'E_PLUGIN_BUNDLE_PATCH',
    ],
    [
      'integrity',
      (locked: PackLockedPlugin) => ({
        ...locked,
        integrity: { kind: 'npm-sri' as const, value: 'sha512-AA==' },
      }),
      'E_PLUGIN_LOCK_MISMATCH',
    ],
  ])('rejects mismatched expected %s', async (_label, mutate, code) => {
    const root = await temporary();
    const locked = await installedNpm(root);
    await expect(verifyInstalledPlugin(root, npmDeclaration, mutate(locked))).rejects.toMatchObject(
      { code },
    );
  });

  it('rejects unsafe/missing patch, alias package name, and missing profile bundle', async () => {
    const traversal = await temporary();
    const traversalLock = await installedNpm(traversal, {
      dsh: { bundle: { patch: '../outside.yml' } },
    });
    traversalLock.bundlePatch = '../outside.yml';
    await expect(
      verifyInstalledPlugin(traversal, npmDeclaration, traversalLock),
    ).rejects.toMatchObject({
      code: 'E_PLUGIN_BUNDLE_PATCH_PATH',
    });

    const alias = await temporary();
    const aliasLock = await installedNpm(alias, { name: 'other-package' });
    await expect(verifyInstalledPlugin(alias, npmDeclaration, aliasLock)).rejects.toMatchObject({
      code: 'E_PLUGIN_PACKAGE_ALIAS',
    });

    const absent = await temporary();
    const absentLock = await installedNpm(absent);
    await writeFile(
      join(absent, 'package.json'),
      JSON.stringify({
        dependencies: { 'yocto-queue': '1.2.2' },
        dsh: { profile: { bundles: [] } },
      }),
    );
    await expect(verifyInstalledPlugin(absent, npmDeclaration, absentLock)).rejects.toMatchObject({
      code: 'E_PLUGIN_PROFILE_BUNDLE',
    });
  });

  it.each([undefined, '', '\\outside.yml', '/outside.yml', 'C:/outside.yml', 'a//b.yml'])(
    'rejects unsafe bundle patch spelling %s',
    async (patch) => {
      const root = await temporary();
      const locked = await installedNpm(root, { dsh: { bundle: { patch } } });
      if (typeof patch === 'string') locked.bundlePatch = patch;
      await expect(verifyInstalledPlugin(root, npmDeclaration, locked)).rejects.toMatchObject({
        code: expect.stringMatching(/^E_PLUGIN_BUNDLE_PATCH/u),
      });
    },
  );

  it('accepts an explicitly unverified expected digest only while returning the actual lock fact', async () => {
    const root = await temporary();
    const locked = await installedNpm(root);
    const expected: PackLockedPlugin = {
      ...locked,
      integrity: { kind: 'unverified', reason: 'explicitly allowed by engine' },
    };
    const fact = await verifyInstalledPlugin(root, npmDeclaration, expected);
    expect(fact.actualIntegrity).toEqual(locked.integrity);
  });

  it('rejects missing bundle patch files, dependencies, and nested profile structure', async () => {
    const missingPatch = await temporary();
    const missingPatchLock = await installedNpm(missingPatch);
    await rm(join(missingPatch, 'node_modules', 'yocto-queue', 'cordis.patch.yml'));
    await expect(
      verifyInstalledPlugin(missingPatch, npmDeclaration, missingPatchLock),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_BUNDLE_PATCH_PATH' });

    const missingDependency = await temporary();
    const missingDependencyLock = await installedNpm(missingDependency);
    await writeFile(
      join(missingDependency, 'package.json'),
      JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['yocto-queue'] } } }),
    );
    await expect(
      verifyInstalledPlugin(missingDependency, npmDeclaration, missingDependencyLock),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_PROFILE_DEPENDENCY' });

    const badProfile = await temporary();
    const badProfileLock = await installedNpm(badProfile);
    await writeFile(
      join(badProfile, 'package.json'),
      JSON.stringify({ dependencies: { 'yocto-queue': '1.2.2' } }),
    );
    await expect(
      verifyInstalledPlugin(badProfile, npmDeclaration, badProfileLock),
    ).rejects.toMatchObject({
      code: 'E_PLUGIN_PROFILE_BUNDLE',
    });
  });

  it('rejects malformed/missing manifests, missing lock, and symlinked package roots', async () => {
    const malformed = await temporary();
    const malformedLock = await installedNpm(malformed);
    await writeFile(join(malformed, 'node_modules', 'yocto-queue', 'package.json'), '{');
    await expect(
      verifyInstalledPlugin(malformed, npmDeclaration, malformedLock),
    ).rejects.toMatchObject({
      code: 'E_PLUGIN_PACKAGE_JSON',
    });

    const missingLock = await temporary();
    const expected = await installedNpm(missingLock);
    await rm(join(missingLock, 'pnpm-lock.yaml'));
    await expect(
      verifyInstalledPlugin(missingLock, npmDeclaration, expected),
    ).rejects.toMatchObject({
      code: 'E_PLUGIN_LOCK',
    });

    const linked = await temporary();
    const linkedExpected = await installedNpm(linked);
    const target = await temporary();
    await mkdir(join(target, 'yocto-queue'));
    await rm(join(linked, 'node_modules', 'yocto-queue'), { recursive: true });
    await symlink(
      join(target, 'yocto-queue'),
      join(linked, 'node_modules', 'yocto-queue'),
      'junction',
    );
    await expect(
      verifyInstalledPlugin(linked, npmDeclaration, linkedExpected),
    ).rejects.toMatchObject({
      code: 'E_PLUGIN_PATH_ALIAS',
    });
  });
});
