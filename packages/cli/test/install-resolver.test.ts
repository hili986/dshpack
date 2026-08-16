import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type ReadPackResult,
  readValidatedPack,
  type ValidatedPackMaterial,
} from '../src/install/read.js';
import { frozenInstallResolution, resolveInstallPlugins } from '../src/install/resolver.js';
import { createNodeInstallRuntime } from '../src/install/runtime.js';
import type { PathProcessRuntime } from '../src/install/runtime-process.js';
import { enginePack, snapshot } from './install-engine-fixture.js';

const roots: string[] = [];

function materialOf(result: ReadPackResult): ValidatedPackMaterial {
  if (result.material === undefined) throw new Error('expected validated resolver fixture');
  return result.material;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('install manifest resolver', () => {
  it('resolves npm in a private scripts-disabled temp workspace and removes it', async () => {
    const source = await enginePack({ plugin: {} });
    await rm(join(source, 'pack.lock.yml'));
    const dshHome = await mkdtemp(join(tmpdir(), 'dshpack-resolver-home-'));
    roots.push(dshHome);
    const sourceBefore = await snapshot(source);
    const homeBefore = await snapshot(dshHome);
    const read = await readValidatedPack(source, { frozen: false });
    expect(read.material).toBeDefined();
    const calls: Array<{ args: readonly string[]; cwd: string; policy: string | undefined }> = [];
    let resolverRoot = '';
    const integrity = `sha512-${createHash('sha512').update('registry-tarball').digest('base64')}`;
    const process: PathProcessRuntime = {
      probe: async () => ({ dshVersion: '0.1.0-rc.6', pnpmVersion: '11.7.0' }),
      runDsh: async () => ({ stdout: '', stderr: '' }),
      async runPnpm(args, options) {
        resolverRoot = options.cwd;
        calls.push({ args, cwd: options.cwd, policy: options.scriptPolicy });
        await writeFile(
          join(options.cwd, 'pnpm-lock.yaml'),
          [
            "lockfileVersion: '9.0'",
            'importers:',
            '  .:',
            '    dependencies:',
            '      example-bundle:',
            '        specifier: ^1.0.0',
            '        version: 1.2.3',
            'packages:',
            '  example-bundle@1.2.3:',
            '    resolution:',
            `      integrity: ${integrity}`,
            '',
          ].join('\n'),
        );
        return { stdout: '', stderr: '' };
      },
    };
    const runtime = createNodeInstallRuntime(dshHome, { process });

    const resolution = await runtime.resolvePlugins(materialOf(read), {
      dshHome,
      frozen: false,
    });

    expect(resolution).toMatchObject({
      mode: 'manifest',
      resolutionDigest: expect.stringMatching(/^sha256-/u),
      plugins: [
        {
          name: 'example-bundle',
          resolved: { version: '1.2.3' },
          integrity: { kind: 'npm-sri', value: integrity },
        },
      ],
    });
    expect(resolution.plugins[0]).not.toHaveProperty('expectedInstalledFacts');
    expect(calls).toEqual([
      {
        args: [
          'add',
          '--lockfile-only',
          '--ignore-scripts',
          '--store-dir',
          join(resolverRoot, 'store'),
          '--cache-dir',
          join(resolverRoot, 'cache'),
          '--state-dir',
          join(resolverRoot, 'state'),
          'example-bundle@^1.0.0',
        ],
        cwd: resolverRoot,
        policy: 'deny',
      },
    ]);
    await expect(access(resolverRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshot(source)).toEqual(sourceBefore);
    expect(await snapshot(dshHome)).toEqual(homeBefore);
    expect(await readFile(join(source, 'pack.yml'), 'utf8')).toContain('example-bundle');
  });

  it('derives tarball sha512 through the bound secure transport without invoking pnpm', async () => {
    const source = await enginePack({ plugin: { source: 'tarball' } });
    await rm(join(source, 'pack.lock.yml'));
    const read = await readValidatedPack(source, { frozen: false });
    const bytes = Buffer.from('resolved remote tarball');
    const process: PathProcessRuntime = {
      probe: async () => ({ dshVersion: '0.1.0-rc.6', pnpmVersion: '11.7.0' }),
      runDsh: async () => ({ stdout: '', stderr: '' }),
      runPnpm: async () => {
        throw new Error('tarball resolution must not invoke pnpm');
      },
    };
    const tarHome = await mkdtemp(join(tmpdir(), 'dshpack-tar-home-'));
    roots.push(tarHome);
    const runtime = createNodeInstallRuntime(tarHome, {
      process,
      network: {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        download: async () => ({
          statusCode: 200,
          body: (async function* () {
            yield bytes.subarray(0, 4);
            yield bytes.subarray(4);
          })(),
        }),
      },
    });

    const resolution = await runtime.resolvePlugins(materialOf(read), {
      dshHome: join(tmpdir(), 'absent-dsh-home'),
      frozen: false,
    });

    expect(resolution.plugins).toEqual([
      {
        name: 'example-bundle',
        resolved: { url: 'https://plugins.example/example-bundle.tgz' },
        integrity: {
          kind: 'sha512',
          value: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        },
      },
    ]);
  });

  it('derives pinned GitHub and frozen resolutions without any subprocess or network', async () => {
    const source = await enginePack({ plugin: {} });
    const frozen = await readValidatedPack(source, { frozen: true });
    const process: PathProcessRuntime = {
      probe: async () => ({ dshVersion: '0.1.0-rc.6', pnpmVersion: '11.7.0' }),
      runDsh: async () => ({ stdout: '', stderr: '' }),
      runPnpm: async () => {
        throw new Error('pinned resolution must not invoke pnpm');
      },
    };
    const runtime = createNodeInstallRuntime(join(tmpdir(), 'absent-home'), {
      process,
      network: { download: async () => Promise.reject(new Error('unexpected network')) },
    });
    const frozenMaterial = materialOf(frozen);
    const frozenResolution = await runtime.resolvePlugins(frozenMaterial, {
      dshHome: join(tmpdir(), 'absent-home'),
      frozen: true,
    });
    expect(frozenResolution).toMatchObject({
      mode: 'frozen',
      resolutionDigest: frozen.material?.lockDigest,
      plugins: [expect.objectContaining({ expectedInstalledFacts: expect.any(Object) })],
    });

    const commit = '0123456789abcdef0123456789abcdef01234567';
    const base = frozenMaterial;
    const githubMaterial = {
      paths: base.paths,
      files: base.files,
      sourceFiles: base.sourceFiles,
      manifestDigest: base.manifestDigest,
      manifest: {
        ...base.manifest,
        plugins: [
          {
            name: 'example-bundle',
            source: { kind: 'github' as const, owner: 'owner', repo: 'repo', ref: commit },
            allowBuilds: false,
          },
        ],
      },
    };
    const github = await runtime.resolvePlugins(githubMaterial, {
      dshHome: join(tmpdir(), 'absent-home'),
      frozen: false,
    });
    expect(github.plugins).toEqual([
      {
        name: 'example-bundle',
        resolved: { commit },
        integrity: { kind: 'git-commit', value: commit },
      },
    ]);
  });

  it('fails closed when a resolver workspace cannot be cleaned', async () => {
    const source = await enginePack({ plugin: {} });
    await rm(join(source, 'pack.lock.yml'));
    const read = await readValidatedPack(source, { frozen: false });
    const workspace = await mkdtemp(join(tmpdir(), 'dshpack-resolver-cleanup-'));
    roots.push(workspace);
    const process: PathProcessRuntime = {
      probe: async () => ({ dshVersion: '0.1.0-rc.6', pnpmVersion: '11.7.0' }),
      runDsh: async () => ({ stdout: '', stderr: '' }),
      async runPnpm(_args, options) {
        await writeFile(
          join(options.cwd, 'pnpm-lock.yaml'),
          "lockfileVersion: '9.0'\nimporters: {}\npackages: {}\n",
        );
        return { stdout: '', stderr: '' };
      },
    };

    await expect(
      resolveInstallPlugins(
        materialOf(read),
        { dshHome: join(tmpdir(), 'absent-home'), frozen: false },
        {
          process,
          makeWorkspace: async () => workspace,
          removeWorkspace: async () => {
            throw new Error('injected cleanup failure');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'E_RESOLUTION_CLEANUP', exitCode: 20 });
  });

  it('cleans a resolver workspace even when private-mode setup fails', async () => {
    const source = await enginePack({ plugin: {} });
    await rm(join(source, 'pack.lock.yml'));
    const read = await readValidatedPack(source, { frozen: false });
    const setupRoot = await mkdtemp(join(tmpdir(), 'dshpack-resolver-setup-'));
    roots.push(setupRoot);
    const missing = join(setupRoot, 'missing');
    let cleanupCalls = 0;

    await expect(
      resolveInstallPlugins(
        materialOf(read),
        { dshHome: missing, frozen: false },
        {
          process: {} as PathProcessRuntime,
          makeWorkspace: async () => missing,
          removeWorkspace: async () => {
            cleanupCalls += 1;
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_RESOLUTION', exitCode: 20 });
    expect(cleanupCalls).toBe(1);
  });

  it('rejects frozen material without a verified lock and bounds generated lock bytes', async () => {
    const source = await enginePack({ plugin: {} });
    await rm(join(source, 'pack.lock.yml'));
    const read = await readValidatedPack(source, { frozen: false });
    const material = materialOf(read);
    expect(() => frozenInstallResolution(material)).toThrowError(
      expect.objectContaining({ code: 'E_NO_LOCK', exitCode: 20 }),
    );
    const workspace = await mkdtemp(join(tmpdir(), 'dshpack-resolver-limit-'));
    roots.push(workspace);
    await expect(
      resolveInstallPlugins(
        material,
        { dshHome: workspace, frozen: false },
        {
          process: {
            async runPnpm(_args, options) {
              await writeFile(
                join(options.cwd, 'pnpm-lock.yaml'),
                Buffer.alloc(10 * 1024 * 1024 + 1),
              );
              return { stdout: '', stderr: '' };
            },
          } as PathProcessRuntime,
          makeWorkspace: async () => workspace,
        },
      ),
    ).rejects.toMatchObject({ code: 'E_RESOLUTION_LOCK_LIMIT', exitCode: 20 });
  });

  it('preserves lock reconciliation diagnostics and rejects a missing resolver result', async () => {
    const source = await enginePack({ plugin: {} });
    await rm(join(source, 'pack.lock.yml'));
    const read = await readValidatedPack(source, { frozen: false });
    const base = materialOf(read);
    const workspace = await mkdtemp(join(tmpdir(), 'dshpack-resolver-empty-lock-'));
    roots.push(workspace);
    await expect(
      resolveInstallPlugins(
        base,
        { dshHome: workspace, frozen: false },
        {
          process: {
            async runPnpm(_args, options) {
              await writeFile(join(options.cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
              return { stdout: '', stderr: '' };
            },
          } as PathProcessRuntime,
          makeWorkspace: async () => workspace,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 20 });

    const hostilePlugins = {
      filter: () => [],
      map: (callback: (plugin: { name: string }) => unknown) => [callback({ name: 'missing' })],
      *[Symbol.iterator]() {},
    } as unknown as ValidatedPackMaterial['manifest']['plugins'];
    await expect(
      resolveInstallPlugins(
        { ...base, manifest: { ...base.manifest, plugins: hostilePlugins } },
        { dshHome: workspace, frozen: false },
        { process: {} as PathProcessRuntime },
      ),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_RESOLUTION', exitCode: 20 });
  });
});
