import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';

import { confirm, isCancel } from '@clack/prompts';

import { writeFileAtomic } from '../adapters/fs.js';
import { materializeSource } from '../adapters/source.js';
import type { NetworkDependencies } from '../adapters/source-network.js';
import { runDoctor } from '../doctor/engine.js';
import { createNodeTransactionAdapter } from '../transaction-node-adapter.js';
import { stagePluginTarballDownload } from './plugin-download.js';
import { auditInstalledBuildScripts } from './profile-builds.js';
import { validateOfficialProfileInit } from './profile-init.js';
import { verifyInstalledPlugin } from './profile-plugin.js';
import { readValidatedPack } from './read.js';
import { resolveInstallPlugins } from './resolver.js';
import { authorizeWorkspaceBuild, writeMaterialAssetSnapshot } from './runtime-assets.js';
import { createPathProcessRuntime, type PathProcessRuntime } from './runtime-process.js';
import { captureInstallTargetState } from './runtime-state.js';
import type { InstallRuntime } from './runtime-types.js';
import type { InstallPromptDecision } from './types.js';

export interface NodeInstallRuntimeOptions {
  confirm?: (prompt: InstallPromptDecision) => Promise<boolean>;
  env?: Readonly<NodeJS.ProcessEnv>;
  network?: NetworkDependencies;
  now?: () => string;
  process?: PathProcessRuntime;
  txid?: () => string;
  writeStderr?: (message: string) => void;
}

async function defaultConfirm(prompt: InstallPromptDecision): Promise<boolean> {
  const answer = await confirm({
    message: `${prompt.kind}: ${prompt.subject}`,
    initialValue: false,
    output: process.stderr,
  });
  return !isCancel(answer) && answer === true;
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

/** Production runtime: PATH-only subprocesses, bound target state, and immutable pack bytes. */
export function createNodeInstallRuntime(
  dshHome: string,
  options: NodeInstallRuntimeOptions = {},
): InstallRuntime {
  const processRuntime =
    options.process ??
    createPathProcessRuntime(options.env === undefined ? {} : { env: options.env });
  return {
    transactionAdapter: createNodeTransactionAdapter(),
    materializeSource,
    readValidatedPack: (directory, readOptions) =>
      readValidatedPack(directory, { frozen: readOptions?.frozen === true }),
    probe: () => processRuntime.probe(dshHome),
    resolvePlugins: (material, resolutionOptions) =>
      resolveInstallPlugins(material, resolutionOptions, {
        process: processRuntime,
        ...(options.network === undefined ? {} : { network: options.network }),
      }),
    captureTargetState: captureInstallTargetState,
    pathExists: exists,
    readText: (path) => readFile(path, 'utf8'),
    async readTextIfExists(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    atomicWriteText: (path, contents) =>
      writeFileAtomic(path, contents, { mode: 0o600, dirMode: 0o700 }),
    writeMaterialAsset: writeMaterialAssetSnapshot,
    authorizeBuild: authorizeWorkspaceBuild,
    runDsh: processRuntime.runDsh,
    runPnpm: processRuntime.runPnpm,
    confirm: options.confirm ?? defaultConfirm,
    writeStderr: options.writeStderr ?? ((message) => process.stderr.write(`${message}\n`)),
    verifyOfficialProfileInit: validateOfficialProfileInit,
    verifyInstalledPlugin,
    auditInstalledBuildScripts,
    stagePluginTarball: (plugin, locked, privateParent) =>
      stagePluginTarballDownload(plugin, locked, privateParent, options.network),
    runDoctor: (input) =>
      runDoctor(
        {
          ...input,
          ...(options.env === undefined ? {} : { env: options.env }),
        },
        {
          runDsh: (args, doctorOptions) =>
            processRuntime.runDsh(args, {
              dshHome: doctorOptions.dshHome,
              cwd: doctorOptions.cwd,
            }),
        },
      ),
    fault: async () => undefined,
    now: options.now ?? (() => new Date().toISOString()),
    txid: options.txid ?? (() => `tx-${randomUUID()}`),
  };
}
