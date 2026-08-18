import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import type { Diagnostic, PackManifest } from '@dshpack/core';
import { afterEach } from 'vitest';
import { stringify } from 'yaml';

import { writeFileAtomic } from '../src/adapters/fs.js';
import { digestTargetBeforeState } from '../src/install/build-plan.js';
import { validateOfficialProfileInit } from '../src/install/profile-init.js';
import { stageVerifiedPluginTarball } from '../src/install/profile-tarball.js';
import { buildAuthorizationKey } from '../src/install/profile-workspace.js';
import { readValidatedPack } from '../src/install/read.js';
import type {
  InstallRuntime,
  InstallRuntimeStage,
  InstallSubprocessResult,
} from '../src/install/runtime-types.js';
import { createNodeTransactionAdapter } from '../src/transaction-node-adapter.js';
import { removeFixtureDirectory } from './fixture-cleanup.js';
import { fakeInstallResolution } from './install-engine-resolution-fixture.js';

const sha512 = (content: string): string =>
  `sha512-${createHash('sha512').update(content).digest('base64')}`;

export interface EnginePackOptions {
  assets?: boolean;
  name?: string;
  mcp?: boolean;
  permissionPreset?: 'workspace-write' | 'danger-full-access';
  tested?: string[];
  plugin?: { allowBuilds?: boolean; source?: 'npm' | 'tarball'; unverified?: boolean };
}

const packRoots = new Set<string>();

export async function cleanupEnginePackFixtures(): Promise<void> {
  const pending = [...packRoots];
  for (const root of pending) packRoots.delete(root);
  await Promise.all(pending.map((root) => removeFixtureDirectory(root)));
}

afterEach(cleanupEnginePackFixtures);

export async function enginePack(options: EnginePackOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-engine-pack-'));
  packRoots.add(root);
  const manifest: PackManifest = {
    formatVersion: 0,
    name: options.name ?? 'engine-pack',
    version: '1.0.0',
    description: 'engine fixture',
    author: 'tester',
    license: 'MIT',
    dsh: { tested: options.tested ?? ['0.1.0-rc.6'] },
    plugins:
      options.plugin === undefined
        ? []
        : [
            {
              name: 'example-bundle',
              source:
                options.plugin.source === 'tarball'
                  ? { kind: 'tarball', url: 'https://plugins.example/example-bundle.tgz' }
                  : { kind: 'npm', range: '^1.0.0' },
              allowBuilds: options.plugin.allowBuilds === true,
            },
          ],
    mcp: options.mcp
      ? [
          {
            serverName: 'docs',
            transport: 'streamable-http',
            url: 'https://mcp.example/docs',
          },
        ]
      : [],
    defaults: {
      ...(options.assets ? { agentPreset: 'custom' } : {}),
      permissionPreset: options.permissionPreset ?? 'workspace-write',
    },
    ...(options.assets
      ? { settings: { namespaces: { 'agent-presets': 'agent-presets.yml' } } }
      : {}),
  };
  const payloads: Record<string, string> = { 'patch/cordis.patch.yml': '[]\n' };
  if (options.assets) {
    payloads['skills/notes.md'] = '---\nname: notes\ndescription: fixture notes\n---\n# Notes\n';
    payloads['presets/custom/agent.cordis.yml'] = '[]\n';
    payloads['settings/agent-presets.yml'] = 'custom:\n  model: fixture\n';
  }
  const manifestText = stringify(manifest, { lineWidth: 0 });
  await writeFile(join(root, 'pack.yml'), manifestText);
  for (const [path, content] of Object.entries(payloads)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const lock = {
    lockVersion: 0,
    manifestSha256: `sha256-${createHash('sha256').update(manifestText).digest('base64url')}`,
    generatedBy: 'dshpack@test',
    generatedAt: '2026-08-16T00:00:00Z',
    dsh: { exportedFrom: '0.1.0-rc.6' },
    plugins:
      options.plugin === undefined
        ? []
        : [
            {
              name: 'example-bundle',
              resolved:
                options.plugin.source === 'tarball'
                  ? { url: 'https://plugins.example/example-bundle.tgz' }
                  : { version: '1.0.0' },
              integrity: options.plugin.unverified
                ? { kind: 'unverified', reason: 'fixture mutant' }
                : {
                    kind: options.plugin.source === 'tarball' ? 'sha512' : 'npm-sri',
                    value: sha512('example-bundle-tarball'),
                  },
              packageJsonSha512: sha512('example-bundle-package-json'),
              bundlePatch: 'lib/index.yml',
            },
          ],
    files: Object.entries(payloads).map(([path, content]) => ({ path, sha512: sha512(content) })),
  };
  await writeFile(join(root, 'pack.lock.yml'), stringify(lock, { lineWidth: 0 }));
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function officialInit(profileRoot: string, profile: string): Promise<void> {
  await writeFile(
    join(profileRoot, 'package.json'),
    `${JSON.stringify({
      name: `dsh-profile-${profile}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    })}\n`,
  );
  await writeFile(join(profileRoot, 'cordis.patch.yml'), '# official fixture\n[]\n');
  await writeFile(
    join(profileRoot, 'pnpm-workspace.yaml'),
    'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  );
}

export interface FakeRuntimeControl {
  confirmations?: boolean[];
  fault?: InstallRuntimeStage;
  transitive?: string[];
  onConfirm?: () => Promise<void>;
  rollbackFailure?: boolean;
  settingsCasMutation?: string;
}

export interface FakeRuntimeResult {
  runtime: InstallRuntime & {
    createScratchRuntime?(dshHome: string, legacyInstalledAt: string): InstallRuntime;
    removeScratch?(dshHome: string): Promise<void>;
  };
  calls: string[];
  stderr: string[];
  scriptPolicies: Array<{ command: 'dsh' | 'pnpm'; policy: string | undefined }>;
}

export function fakeRuntime(control: FakeRuntimeControl = {}): FakeRuntimeResult {
  const calls: string[] = [];
  const stderr: string[] = [];
  const scriptPolicies: FakeRuntimeResult['scriptPolicies'] = [];
  const confirmations = [...(control.confirmations ?? [])];
  const baseAdapter = createNodeTransactionAdapter();
  let settingsMutated = false;
  const transactionAdapter = {
    ...baseAdapter,
    async compareAndSwapText(path: string, expected: string | undefined, replacement: string) {
      if (
        control.settingsCasMutation !== undefined &&
        path.endsWith('settings.yaml') &&
        !settingsMutated
      ) {
        settingsMutated = true;
        await writeFile(path, control.settingsCasMutation);
      }
      return baseAdapter.compareAndSwapText(path, expected, replacement);
    },
    async moveArtifactPath(...args: Parameters<typeof baseAdapter.moveArtifactPath>) {
      const backupPath = args[3];
      const artifact = args[1];
      if (
        control.rollbackFailure === true &&
        artifact === 'profile' &&
        backupPath.includes(`${sep}new${sep}`)
      ) {
        throw new Error('injected rollback failure');
      }
      return baseAdapter.moveArtifactPath(...args);
    },
  };
  const runtime: InstallRuntime = {
    transactionAdapter,
    async materializeSource(reference) {
      calls.push(`materialize:${reference}`);
      return {
        directory: reference,
        provenance: { kind: 'directory', path: reference },
        async cleanup() {
          calls.push('cleanup:source');
        },
      };
    },
    readValidatedPack: (directory, options) =>
      readValidatedPack(directory, { frozen: options?.frozen === true }),
    async probe() {
      calls.push('probe');
      return { dshVersion: '0.1.0-rc.6', pnpmVersion: '11.7.0' };
    },
    async resolvePlugins(material, options) {
      calls.push(`resolve:${options.frozen ? 'frozen' : 'manifest'}`);
      return fakeInstallResolution(material, options.frozen);
    },
    pathExists: exists,
    async captureTargetState(input) {
      const stateAt = async (relativePath: string) => {
        const path = join(input.dshHome, ...relativePath.split('/'));
        if (!(await exists(path))) return { path: relativePath, state: 'absent' as const };
        const metadata = await lstat(path);
        const bytes = metadata.isDirectory()
          ? Buffer.from(JSON.stringify(await snapshot(path)))
          : await readFile(path);
        return {
          path: relativePath,
          state: 'present' as const,
          sha256: `sha256-${createHash('sha256').update(bytes).digest('base64url')}`,
        };
      };
      const state = {
        profile: await stateAt(`profiles/${input.profile}`),
        skills: await Promise.all(input.skills.map(stateAt)),
        presets: await Promise.all(input.presets.map(stateAt)),
        settings: await stateAt('settings.yaml'),
        ...(input.externalDefaultPreset === undefined
          ? {}
          : { externalDefaultPreset: await stateAt(input.externalDefaultPreset) }),
      };
      return {
        state,
        digest: digestTargetBeforeState(state),
        ...((await exists(join(input.dshHome, 'settings.yaml')))
          ? { settingsDocument: await readFile(join(input.dshHome, 'settings.yaml'), 'utf8') }
          : {}),
      };
    },
    async readText(path) {
      return readFile(path, 'utf8');
    },
    async readTextIfExists(path) {
      return (await exists(path)) ? readFile(path, 'utf8') : undefined;
    },
    async atomicWriteText(path, contents) {
      await writeFileAtomic(path, contents, { mode: 0o600, dirMode: 0o700 });
    },
    async writeMaterialAsset(material, source, target, kind) {
      const selected = material.files.filter(({ path }) =>
        source.endsWith('.md') ? path === source : path.startsWith(`${source}/`),
      );
      for (const file of selected) {
        const relative = source.endsWith('.md')
          ? kind === 'skill'
            ? 'SKILL.md'
            : (file.path.split('/').at(-1) as string)
          : file.path.slice(source.length + 1);
        const destination = join(target, ...relative.split('/'));
        await mkdir(join(destination, '..'), { recursive: true });
        await writeFile(destination, Buffer.from(file.contentBase64, 'base64'));
      }
    },
    async authorizeBuild(_profileRoot, authorizationKey) {
      calls.push(`allow-build:${authorizationKey}`);
    },
    async runDsh(args, options): Promise<InstallSubprocessResult> {
      calls.push(`dsh:${args.join(' ')}`);
      scriptPolicies.push({ command: 'dsh', policy: options.scriptPolicy });
      const profileIndex = args.indexOf('--profile');
      const profile = args[profileIndex + 1] as string;
      const profileRoot = join(options.dshHome, 'profiles', profile);
      if (args.includes('list')) await officialInit(profileRoot, profile);
      if (args.includes('--dump-config')) await writeFile(join(profileRoot, 'cordis.yml'), '[]\n');
      return { stdout: args.includes('--version') ? '0.1.0-rc.6\n' : '', stderr: '' };
    },
    async runPnpm(args, options) {
      calls.push(`pnpm:${args.join(' ')}`);
      scriptPolicies.push({ command: 'pnpm', policy: options.scriptPolicy });
      return { stdout: '', stderr: '' };
    },
    async confirm(prompt) {
      calls.push(`confirm:${prompt.kind}:${prompt.subject}`);
      await control.onConfirm?.();
      return confirmations.shift() ?? false;
    },
    writeStderr(message) {
      stderr.push(message);
    },
    verifyOfficialProfileInit: validateOfficialProfileInit,
    async verifyInstalledPlugin(_profileRoot, plugin, locked) {
      calls.push(`verify-plugin:${plugin.name}`);
      return {
        name: plugin.name,
        packageJsonSha512:
          locked.expectedInstalledFacts?.packageJsonSha512 ?? sha512('example-bundle-package-json'),
        bundlePatch: locked.expectedInstalledFacts?.bundlePatch ?? 'lib/index.yml',
        actualResolved: locked.resolved,
        actualIntegrity:
          locked.integrity.kind === 'unverified'
            ? { kind: 'npm-sri' as const, value: 'sha512-actual-installed-fact' }
            : locked.integrity,
      };
    },
    async auditInstalledBuildScripts(_profileRoot, plugins, approvedBuilds) {
      const transitive = control.transitive ?? [];
      const direct = plugins
        .filter((plugin) => plugin.allowBuilds === true)
        .map((plugin) => ({
          name: plugin.name,
          authorizationKey: buildAuthorizationKey(plugin),
          scripts: ['install'] as ('install' | 'preinstall' | 'postinstall' | 'prepare')[],
        }));
      return {
        approvedDirect: direct.filter(({ authorizationKey }) =>
          approvedBuilds.has(authorizationKey),
        ),
        transitive: transitive.map((name) => ({
          name,
          authorizationKey: name,
          scripts: ['install'] as const,
        })),
        unapprovedDirectBuildKeys: direct
          .filter(({ authorizationKey }) => !approvedBuilds.has(authorizationKey))
          .map(({ authorizationKey }) => authorizationKey),
        unexpectedTransitiveBuildKeys: [...transitive],
      };
    },
    async stagePluginTarball(_plugin, locked, privateParent) {
      if (locked.integrity.kind !== 'sha512') throw new Error('fixture tarball needs sha512');
      const download = join(privateParent, `fixture-${randomUUID()}.tgz`);
      await writeFile(download, 'example-bundle-tarball');
      const staged = await stageVerifiedPluginTarball(
        download,
        privateParent,
        locked.integrity.value,
      );
      return {
        staged,
        async cleanup() {
          calls.push('cleanup:plugin');
          await removeFixtureDirectory(dirname(staged.path));
        },
      };
    },
    async runDoctor(input) {
      calls.push(`doctor:${input.profile}`);
      return {
        diagnostics: [] as Diagnostic[],
        exitCode: 0,
        metadata: {
          ...(input.profile === undefined ? {} : { profile: input.profile }),
          sideEffects: [
            { owner: 'dsh', path: 'profile/cordis.yml' },
            { owner: 'dshpack', path: '.dshpack/logs/<file>' },
          ],
        },
      };
    },
    async fault(stage) {
      calls.push(`stage:${stage}`);
      if (stage === control.fault) throw new Error(`injected-${stage}`);
    },
    now: () => '2026-08-16T12:00:00.000Z',
    txid: () => `tx-${randomUUID()}`,
  };
  return {
    runtime: Object.assign(runtime, {
      // Migration's reconstruction must never reuse the live runtime.  A fresh fake keeps all
      // subprocess/write call logs separate while still exercising the isolated scratch replay.
      createScratchRuntime: () => fakeRuntime().runtime,
    }),
    calls,
    stderr,
    scriptPolicies,
  };
}

export async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    if (!(await exists(directory))) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result[path.slice(root.length + 1)] = (await readFile(path)).toString('base64');
    }
  };
  await visit(root);
  return result;
}
