import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginDeclaration } from '@dshpack/core';
import { afterEach, describe, expect, it } from 'vitest';

import { auditInstalledBuildScripts } from '../src/install/profile-builds.js';
import { buildAuthorizationKey } from '../src/install/profile-workspace.js';

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-profile-builds-'));
  roots.push(root);
  await mkdir(join(root, 'node_modules'));
  return root;
}

async function pkg(
  root: string,
  name: string,
  data: Record<string, unknown> = {},
): Promise<string> {
  const directory = join(root, 'node_modules', ...name.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, ...data }));
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const direct: PluginDeclaration = {
  name: 'direct-plugin',
  source: { kind: 'npm', range: '1.0.0' },
  allowBuilds: true,
};

describe('installed build-script audit', () => {
  it('separates explicitly approved direct builds from unexpected transitive builds', async () => {
    const root = await temporary();
    await pkg(root, direct.name, {
      scripts: { preinstall: 'node pre.js', install: 'node install.js', build: 'ignored' },
      dependencies: { transitive: '1.0.0' },
    });
    await pkg(root, 'transitive', {
      scripts: { postinstall: 'node post.js', prepare: 'node prepare.js', test: 'ignored' },
    });
    const directKey = buildAuthorizationKey(direct);

    await expect(auditInstalledBuildScripts(root, [direct], new Set([directKey]))).resolves.toEqual(
      {
        approvedDirect: [
          {
            authorizationKey: 'direct-plugin',
            name: 'direct-plugin',
            scripts: ['preinstall', 'install'],
          },
        ],
        unapprovedDirectBuildKeys: [],
        unexpectedTransitiveBuildKeys: ['transitive'],
        transitive: [
          {
            authorizationKey: 'transitive',
            name: 'transitive',
            scripts: ['postinstall', 'prepare'],
          },
        ],
      },
    );
  });

  it('returns direct keys requiring per-package confirmation and never treats --yes-like input broadly', async () => {
    const root = await temporary();
    await pkg(root, direct.name, { scripts: { install: 'node install.js' } });

    const result = await auditInstalledBuildScripts(root, [direct], new Set(['*', 'direct-*']));
    expect(result.approvedDirect).toEqual([]);
    expect(result.unapprovedDirectBuildKeys).toEqual(['direct-plugin']);
  });

  it('uses the exact GitHub direct key while transitive keys remain a separate second-confirmation set', async () => {
    const root = await temporary();
    const git: PluginDeclaration = {
      name: 'git-plugin',
      source: { kind: 'github', owner: 'owner', repo: 'repo', ref: 'a'.repeat(40) },
      allowBuilds: true,
    };
    await pkg(root, git.name, {
      scripts: { prepare: 'node prepare.js' },
      optionalDependencies: { optional: '1.0.0' },
    });
    await pkg(root, 'optional', { scripts: { install: 'node install.js' } });

    const result = await auditInstalledBuildScripts(
      root,
      [git],
      new Set([buildAuthorizationKey(git)]),
    );
    expect(result.approvedDirect[0]?.authorizationKey).toBe(
      'git-plugin@git+https://github.com/owner/repo.git',
    );
    expect(result.unexpectedTransitiveBuildKeys).toEqual(['optional']);
  });

  it('resolves a nested dependency, handles cycles, skips absent optional/peer deps, and deduplicates', async () => {
    const root = await temporary();
    const directRoot = await pkg(root, direct.name, {
      dependencies: { nested: '1.0.0' },
      optionalDependencies: { absent: '1.0.0' },
      peerDependencies: { 'absent-peer': '1.0.0' },
    });
    const nestedRoot = await pkg(directRoot, 'nested', {
      scripts: { install: 'x' },
      dependencies: { 'direct-plugin': '1.0.0' },
    });
    await mkdir(join(nestedRoot, 'node_modules'), { recursive: true });

    const result = await auditInstalledBuildScripts(root, [direct, direct], new Set());
    expect(result.unexpectedTransitiveBuildKeys).toEqual(['nested']);
    expect(result.transitive).toHaveLength(1);
  });

  it('fails closed for missing required dependencies and package aliases', async () => {
    const missing = await temporary();
    await pkg(missing, direct.name, { dependencies: { absent: '1.0.0' } });
    await expect(auditInstalledBuildScripts(missing, [direct], new Set())).rejects.toMatchObject({
      code: 'E_PLUGIN_DEPENDENCY_MISSING',
    });

    const alias = await temporary();
    await pkg(alias, direct.name, { dependencies: { alias: 'npm:real@1.0.0' } });
    await pkg(alias, 'alias', { name: 'real' });
    await expect(auditInstalledBuildScripts(alias, [direct], new Set())).rejects.toMatchObject({
      code: 'E_PLUGIN_PACKAGE_ALIAS',
    });
  });

  it('fails closed for malformed package metadata and symlinked dependency directories', async () => {
    const malformed = await temporary();
    const directory = await pkg(malformed, direct.name);
    await writeFile(join(directory, 'package.json'), '{');
    await expect(auditInstalledBuildScripts(malformed, [direct], new Set())).rejects.toMatchObject({
      code: 'E_PLUGIN_PACKAGE_JSON',
    });

    const badScripts = await temporary();
    await pkg(badScripts, direct.name, { scripts: { install: true } });
    await expect(auditInstalledBuildScripts(badScripts, [direct], new Set())).rejects.toMatchObject(
      {
        code: 'E_PLUGIN_SCRIPTS',
      },
    );

    const linked = await temporary();
    await pkg(linked, direct.name, { dependencies: { linked: '1.0.0' } });
    const target = await temporary();
    await pkg(target, 'target');
    await symlink(
      join(target, 'node_modules', 'target'),
      join(linked, 'node_modules', 'linked'),
      'junction',
    );
    await expect(auditInstalledBuildScripts(linked, [direct], new Set())).rejects.toMatchObject({
      code: 'E_PLUGIN_PATH_ALIAS',
    });
  });

  it('fails closed for a missing root/node_modules and malformed dependency mappings', async () => {
    const missing = join(await temporary(), 'missing');
    await expect(auditInstalledBuildScripts(missing, [direct], new Set())).rejects.toMatchObject({
      code: 'E_PLUGIN_PATH_ALIAS',
    });
    const noModules = await temporary();
    await rm(join(noModules, 'node_modules'), { recursive: true });
    await expect(auditInstalledBuildScripts(noModules, [direct], new Set())).rejects.toMatchObject({
      code: 'E_PLUGIN_PATH_ALIAS',
    });
    const malformed = await temporary();
    await pkg(malformed, direct.name, { dependencies: { child: true } });
    await expect(auditInstalledBuildScripts(malformed, [direct], new Set())).rejects.toMatchObject({
      code: 'E_PLUGIN_DEPENDENCIES',
    });
  });

  it('reports no expansion for packages without lifecycle scripts', async () => {
    const root = await temporary();
    await pkg(root, direct.name, { scripts: { build: 'not a pnpm lifecycle build gate' } });
    await expect(auditInstalledBuildScripts(root, [direct], new Set())).resolves.toEqual({
      approvedDirect: [],
      transitive: [],
      unapprovedDirectBuildKeys: [],
      unexpectedTransitiveBuildKeys: [],
    });
  });
});
