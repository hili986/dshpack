import type { Diagnostic, PackLockedPlugin, PluginDeclaration } from '@dshpack/core';

import type { MaterializedSource } from '../adapters/source.js';
import type { CommandReport } from '../commands/shared.js';
import type { DoctorInput, DoctorMetadata } from '../doctor/engine.js';
import type { TransactionAdapter } from '../transaction.js';
import type { BuildScriptAudit } from './profile-builds.js';
import type { InstalledPluginFact, StagedPluginTarball } from './profile-plugin.js';
import type { ReadPackResult, ValidatedPackMaterial } from './read.js';
import type {
  InstallPathBeforeState,
  InstallPlan,
  InstallPlanOptions,
  InstallPromptDecision,
  InstallTargetBeforeState,
} from './types.js';

export type InstallRuntimeStage =
  | 'source-cleanup'
  | 'init'
  | 'add'
  | 'verify'
  | 'assets'
  | 'settings'
  | 'dump'
  | 'doctor'
  | 'metadata';

export interface InstallInput extends Omit<InstallPlanOptions, 'sourceArgument'> {
  source: string;
  dshHome: string;
  interactive: boolean;
  json?: boolean;
}

export interface InstallTargetCapture {
  state: InstallTargetBeforeState;
  digest: string;
  settingsDocument?: string;
}

export interface CaptureInstallTargetInput {
  dshHome: string;
  profile: string;
  skills: readonly string[];
  presets: readonly string[];
  externalDefaultPreset?: string;
}

export interface InstallSubprocessResult {
  stdout: string;
  stderr: string;
}

export type LifecycleScriptPolicy = 'deny' | 'allow-approved';

export interface StagedPluginDownload {
  staged: StagedPluginTarball;
  cleanup(): Promise<void>;
}

export interface InstallRuntime {
  transactionAdapter: TransactionAdapter;
  materializeSource(reference: string): Promise<MaterializedSource>;
  readValidatedPack(directory: string): Promise<ReadPackResult>;
  probe(): Promise<{ dshVersion: string; pnpmVersion: string }>;
  captureTargetState(input: CaptureInstallTargetInput): Promise<InstallTargetCapture>;
  pathExists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readTextIfExists(path: string): Promise<string | undefined>;
  atomicWriteText(path: string, contents: string): Promise<void>;
  writeMaterialAsset(
    material: ValidatedPackMaterial,
    source: string,
    target: string,
    kind: 'skill' | 'preset',
  ): Promise<void>;
  authorizeBuild(profileRoot: string, authorizationKey: string): Promise<void>;
  runDsh(
    args: readonly string[],
    options: { dshHome: string; cwd?: string; scriptPolicy?: LifecycleScriptPolicy },
  ): Promise<InstallSubprocessResult>;
  runPnpm(
    args: readonly string[],
    options: { dshHome: string; cwd: string; scriptPolicy?: LifecycleScriptPolicy },
  ): Promise<InstallSubprocessResult>;
  confirm(prompt: InstallPromptDecision): Promise<boolean>;
  writeStderr(message: string): void;
  verifyOfficialProfileInit(profileRoot: string, profile: string): Promise<unknown>;
  verifyInstalledPlugin(
    profileRoot: string,
    plugin: PluginDeclaration,
    locked: PackLockedPlugin,
  ): Promise<InstalledPluginFact>;
  auditInstalledBuildScripts(
    profileRoot: string,
    plugins: readonly PluginDeclaration[],
    approvedBuilds: ReadonlySet<string>,
  ): Promise<BuildScriptAudit>;
  stagePluginTarball(
    plugin: PluginDeclaration,
    locked: PackLockedPlugin,
    privateParent: string,
  ): Promise<StagedPluginDownload>;
  runDoctor(input: DoctorInput): Promise<CommandReport<DoctorMetadata>>;
  fault(stage: InstallRuntimeStage): Promise<void>;
  now(): string;
  txid(): string;
}

export interface InstallReportMetadata {
  status: 'planned' | 'installed' | 'not-started' | 'committed' | 'rolled-back' | 'rollback-failed';
  plan?: InstallPlan;
  profile?: string;
  backupDirectory?: string;
  journalPath?: string;
  manualRecovery?: readonly {
    operation: string;
    sourcePath: string;
    destinationPath: string;
  }[];
  requiredCommand?: {
    argv: readonly string[];
    powerShell: string;
  };
}

export type InstallReport = CommandReport<InstallReportMetadata>;

export type CapturedPathState = InstallPathBeforeState;
export type InstallDiagnostics = readonly Diagnostic[];
