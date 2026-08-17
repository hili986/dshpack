import { createHash } from 'node:crypto';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PackLockedPlugin, PluginDeclaration } from '@dshpack/core';
import { afterEach, describe, expect, it } from 'vitest';

import { auditInstalledBuildScripts } from '../src/install/profile-builds.js';
import {
  inspectConfinedDirectory,
  requirePrivateDirectory,
  requireSecureDirectory,
} from '../src/install/profile-fs.js';
import { validateOfficialProfileInit } from '../src/install/profile-init.js';
import {
  exactPluginAddSpec,
  stageVerifiedPluginTarball,
  verifyInstalledPlugin,
} from '../src/install/profile-plugin.js';

const roots: string[] = [];

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-profile-security-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installedWithPatch(
  root: string,
  patch: string,
): Promise<{
  declaration: PluginDeclaration;
  locked: PackLockedPlugin;
  packagePath: string;
}> {
  const declaration: PluginDeclaration = {
    name: 'secure-plugin',
    source: { kind: 'npm', range: '1.0.0' },
    allowBuilds: false,
  };
  const packageRoot = join(root, 'node_modules', declaration.name);
  await mkdir(packageRoot, { recursive: true });
  const packagePath = join(packageRoot, 'package.json');
  const packageBytes = Buffer.from(
    `${JSON.stringify({
      name: declaration.name,
      version: '1.0.0',
      dsh: { bundle: { patch } },
    })}\n`,
  );
  await writeFile(packagePath, packageBytes);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      dependencies: { [declaration.name]: '1.0.0' },
      dsh: { profile: { bundles: [declaration.name] } },
    }),
  );
  await writeFile(
    join(root, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      secure-plugin:
        specifier: 1.0.0
        version: 1.0.0
packages:
  secure-plugin@1.0.0:
    resolution: {integrity: sha512-AA==}
`,
  );
  return {
    declaration,
    packagePath,
    locked: {
      name: declaration.name,
      resolved: { version: '1.0.0' },
      integrity: { kind: 'npm-sri', value: 'sha512-AA==' },
      packageJsonSha512: sri(packageBytes),
      bundlePatch: patch,
    },
  };
}

describe('bundle patch path boundary', () => {
  it('pins confinement to one stable root and rejects lexical escape', async () => {
    const root = await temporary();
    const stable = await requireSecureDirectory(root);
    await expect(inspectConfinedDirectory(root, stable, root)).resolves.toEqual(stable);
    await expect(
      inspectConfinedDirectory(root, stable, join(root, '..', 'outside')),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_PATH_ALIAS' });
  });

  it('rejects an intermediate junction even when the final entry is an ordinary file', async () => {
    const root = await temporary();
    const external = await temporary();
    await writeFile(join(external, 'patch.yml'), '[]\n');
    const facts = await installedWithPatch(root, 'linked/patch.yml');
    await symlink(external, join(root, 'node_modules', 'secure-plugin', 'linked'), 'junction');

    await expect(
      verifyInstalledPlugin(root, facts.declaration, facts.locked),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_PATH_ALIAS' });
  });

  it.each([
    'patch.yml:stream',
    'CON.yml',
    'dir./patch.yml',
    'dir /patch.yml',
    'bad<name.yml',
    `control${String.fromCharCode(1)}.yml`,
  ])('rejects Windows-unsafe or ADS bundle paths on every OS: %s', async (patch) => {
    const root = await temporary();
    const facts = await installedWithPatch(root, patch);
    await expect(
      verifyInstalledPlugin(root, facts.declaration, facts.locked),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_BUNDLE_PATCH_PATH' });
  });
});

describe('atomic reads and private tarball staging', () => {
  it('requires private POSIX staging and defers directory ACL enforcement on Windows', async () => {
    const root = await temporary();
    await expect(requirePrivateDirectory(root)).resolves.toMatchObject({ canonical: root });

    await chmod(root, 0o755);
    if (process.platform !== 'win32') {
      await expect(requirePrivateDirectory(root)).rejects.toMatchObject({
        code: 'E_PROFILE_DIRECTORY',
      });
    }

    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      await expect(requirePrivateDirectory(root)).resolves.toMatchObject({ canonical: root });
    } finally {
      if (platform === undefined) Reflect.deleteProperty(process, 'platform');
      else Object.defineProperty(process, 'platform', platform);
    }

    if (process.platform === 'win32') {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
      try {
        const mode = (await lstat(root, { bigint: true })).mode & 0o077n;
        const forcedPosix = requirePrivateDirectory(root);
        if (mode === 0n) await expect(forcedPosix).resolves.toMatchObject({ canonical: root });
        else await expect(forcedPosix).rejects.toMatchObject({ code: 'E_PROFILE_DIRECTORY' });
      } finally {
        if (platform === undefined) Reflect.deleteProperty(process, 'platform');
        else Object.defineProperty(process, 'platform', platform);
      }
    }
  });

  it('detects a private staging-parent replacement after secure inspection', async () => {
    const root = await temporary();
    const replacementSource = `${root}.original`;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    try {
      await expect(
        requirePrivateDirectory(root, {
          afterPrivateDirectoryInspection: async (path: string) => {
            await rename(path, replacementSource);
            roots.push(replacementSource);
            await mkdir(path, { mode: 0o700 });
          },
        }),
      ).rejects.toMatchObject({ code: 'E_PROFILE_FILE_CHANGED' });
    } finally {
      if (platform === undefined) Reflect.deleteProperty(process, 'platform');
      else Object.defineProperty(process, 'platform', platform);
    }
  });

  it('detects a package.json swap between lstat and opening the read handle', async () => {
    const root = await temporary();
    const facts = await installedWithPatch(root, 'patch.yml');
    await writeFile(join(root, 'node_modules', 'secure-plugin', 'patch.yml'), '[]\n');
    const replacement = `${facts.packagePath}.replacement`;
    await writeFile(replacement, await readFile(facts.packagePath));
    let swapped = false;

    await expect(
      verifyInstalledPlugin(root, facts.declaration, facts.locked, {
        afterFileLstat: async (path) => {
          if (!swapped && path === facts.packagePath) {
            swapped = true;
            await rename(facts.packagePath, `${facts.packagePath}.old`);
            await rename(replacement, facts.packagePath);
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FILE_CHANGED' });
  });

  it('detects the same lstat-to-open swap in official init and build audits', async () => {
    const initRoot = await temporary();
    await writeFile(
      join(initRoot, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-demo',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      }),
    );
    await writeFile(join(initRoot, 'cordis.patch.yml'), '[]\n');
    await writeFile(
      join(initRoot, 'pnpm-workspace.yaml'),
      "packages: ['.']\nnodeLinker: hoisted\nautoInstallPeers: false\n",
    );
    const initPackage = join(initRoot, 'package.json');
    const initReplacement = join(await temporary(), 'package.json');
    await writeFile(initReplacement, await readFile(initPackage));
    let initSwapped = false;
    await expect(
      validateOfficialProfileInit(initRoot, 'demo', {
        afterFileLstat: async (path) => {
          if (!initSwapped && path === initPackage) {
            initSwapped = true;
            await rename(initPackage, `${initPackage}.old`);
            await rename(initReplacement, initPackage);
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FILE_CHANGED' });

    const buildRoot = await temporary();
    const facts = await installedWithPatch(buildRoot, 'patch.yml');
    const buildReplacement = `${facts.packagePath}.replacement`;
    await writeFile(buildReplacement, await readFile(facts.packagePath));
    let buildSwapped = false;
    await expect(
      auditInstalledBuildScripts(buildRoot, [facts.declaration], new Set(), {
        afterFileLstat: async (path) => {
          if (!buildSwapped && path === facts.packagePath) {
            buildSwapped = true;
            await rename(facts.packagePath, `${facts.packagePath}.old`);
            await rename(buildReplacement, facts.packagePath);
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FILE_CHANGED' });
  });

  it('detects pathname replacement after open and in-place modification after read', async () => {
    const afterOpenRoot = await temporary();
    const afterOpen = await installedWithPatch(afterOpenRoot, 'patch.yml');
    await writeFile(join(afterOpenRoot, 'node_modules', 'secure-plugin', 'patch.yml'), '[]\n');
    const replacement = `${afterOpen.packagePath}.replacement`;
    await writeFile(replacement, await readFile(afterOpen.packagePath));
    let replaced = false;
    await expect(
      verifyInstalledPlugin(afterOpenRoot, afterOpen.declaration, afterOpen.locked, {
        afterFileOpen: async (path) => {
          if (!replaced && path === afterOpen.packagePath) {
            replaced = true;
            await rename(afterOpen.packagePath, `${afterOpen.packagePath}.old`);
            await rename(replacement, afterOpen.packagePath);
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FILE_CHANGED' });

    const afterReadRoot = await temporary();
    const afterRead = await installedWithPatch(afterReadRoot, 'patch.yml');
    await writeFile(join(afterReadRoot, 'node_modules', 'secure-plugin', 'patch.yml'), '[]\n');
    let modified = false;
    await expect(
      verifyInstalledPlugin(afterReadRoot, afterRead.declaration, afterRead.locked, {
        afterFileRead: async (path) => {
          if (!modified && path === afterRead.packagePath) {
            modified = true;
            await appendFile(path, ' ');
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FILE_CHANGED' });
  });

  it('detects directory replacement and missing package roots', async () => {
    const directoryRoot = await temporary();
    const directoryFacts = await installedWithPatch(directoryRoot, 'patch.yml');
    const packageRoot = join(directoryRoot, 'node_modules', 'secure-plugin');
    await writeFile(join(packageRoot, 'patch.yml'), '[]\n');
    const replacementRoot = join(await temporary(), 'secure-plugin');
    await mkdir(replacementRoot);
    let directoryReplaced = false;
    await expect(
      verifyInstalledPlugin(directoryRoot, directoryFacts.declaration, directoryFacts.locked, {
        afterDirectoryLstat: async (path) => {
          if (!directoryReplaced && path === packageRoot) {
            directoryReplaced = true;
            await rename(packageRoot, `${packageRoot}.old`);
            await rename(replacementRoot, packageRoot);
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FILE_CHANGED' });

    const missingRoot = await temporary();
    const missingFacts = await installedWithPatch(missingRoot, 'patch.yml');
    await rm(join(missingRoot, 'node_modules', 'secure-plugin'), { recursive: true });
    await expect(
      verifyInstalledPlugin(missingRoot, missingFacts.declaration, missingFacts.locked),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_PATH_ALIAS' });
  });

  it('copies a verified tarball to a private random path and rechecks identity before add', async () => {
    const root = await temporary();
    const source = join(root, 'download.tgz');
    const bytes = Buffer.from('tarball bytes');
    await writeFile(source, bytes);
    const integrity = sri(bytes);
    const declaration: PluginDeclaration = {
      name: 'tar-plugin',
      source: { kind: 'tarball', url: 'https://example.test/plugin.tgz' },
      allowBuilds: false,
    };
    const locked: PackLockedPlugin = {
      name: declaration.name,
      resolved: { url: 'https://example.test/plugin.tgz' },
      integrity: { kind: 'sha512', value: integrity },
      packageJsonSha512: 'sha512-AA==',
      bundlePatch: 'patch.yml',
    };
    const staged = await stageVerifiedPluginTarball(source, root, integrity);
    expect(staged.path).not.toBe(source);
    await expect(exactPluginAddSpec(declaration, locked, staged)).resolves.toBe(staged.path);

    const replacement = join(root, 'replacement.tgz');
    await writeFile(replacement, bytes);
    await rename(staged.path, `${staged.path}.old`);
    await rename(replacement, staged.path);
    await expect(exactPluginAddSpec(declaration, locked, staged)).rejects.toMatchObject({
      code: 'E_PLUGIN_TARBALL_CHANGED',
    });
  });

  it('fails closed for invalid staging inputs, SRI markers, and in-place staged mutation', async () => {
    const root = await temporary();
    const source = join(root, 'download.tgz');
    const bytes = Buffer.from('verified');
    await writeFile(source, bytes);
    const integrity = sri(bytes);
    await expect(stageVerifiedPluginTarball(source, root, 'invalid')).rejects.toMatchObject({
      code: 'E_PLUGIN_TARBALL_INTEGRITY',
    });
    await expect(stageVerifiedPluginTarball('relative.tgz', root, integrity)).rejects.toMatchObject(
      {
        code: 'E_PLUGIN_TARBALL_PATH',
      },
    );
    const wrongExtension = join(root, 'download.bin');
    await writeFile(wrongExtension, bytes);
    await expect(stageVerifiedPluginTarball(wrongExtension, root, integrity)).rejects.toMatchObject(
      {
        code: 'E_PLUGIN_TARBALL_PATH',
      },
    );
    await expect(stageVerifiedPluginTarball(source, root, 'sha512-AA==')).rejects.toMatchObject({
      code: 'E_PLUGIN_TARBALL_INTEGRITY',
    });

    const staged = await stageVerifiedPluginTarball(source, root, integrity);
    const declaration: PluginDeclaration = {
      name: 'tar-plugin',
      source: { kind: 'tarball', url: 'https://example.test/plugin.tgz' },
      allowBuilds: false,
    };
    const locked: PackLockedPlugin = {
      name: declaration.name,
      resolved: { url: 'https://example.test/plugin.tgz' },
      integrity: { kind: 'sha512', value: integrity },
      packageJsonSha512: 'sha512-AA==',
      bundlePatch: 'patch.yml',
    };
    await expect(
      exactPluginAddSpec(declaration, locked, { ...staged, integrity: 'sha512-AA==' }),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_TARBALL_INTEGRITY' });
    await writeFile(staged.path, 'changed-in-place');
    await expect(exactPluginAddSpec(declaration, locked, staged)).rejects.toMatchObject({
      code: 'E_PLUGIN_TARBALL_INTEGRITY',
    });

    const stagedSwap = await stageVerifiedPluginTarball(source, root, integrity);
    const malicious = join(root, 'malicious.tgz');
    await writeFile(malicious, 'malicious replacement');
    let swapped = false;
    await expect(
      exactPluginAddSpec(declaration, locked, stagedSwap, {
        afterFileSnapshot: async (path) => {
          if (!swapped && path === stagedSwap.path) {
            swapped = true;
            await rename(stagedSwap.path, `${stagedSwap.path}.old`);
            await rename(malicious, stagedSwap.path);
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_FILE_CHANGED' });
  });
});
