export type { DshAdapter } from './adapters/dsh.js';
export type { AtomicWriteOptions, FileSystemAdapter } from './adapters/fs.js';
export { nodeFileSystemAdapter, writeFileAtomic } from './adapters/fs.js';
export type {
  DshInterruptionReason,
  DshLauncher,
  DshProcessResult,
  ProcessAdapter,
  RunDshOptions,
} from './adapters/process.js';
export { DshProcessError, runDsh } from './adapters/process.js';
export type {
  PrepareAgentPresetsMergeInput,
  PreparedAgentPresetsMerge,
  SettingsAdapter,
  SettingsClock,
  YamlSettingsAdapterOptions,
} from './adapters/settings.js';
export {
  compareAndMoveText,
  compareAndSwapText,
  prepareAgentPresetsMerge,
  withSettingsFileLock,
  YamlSettingsAdapter,
} from './adapters/settings.js';
export type { SourceAdapter } from './adapters/source.js';
export { COMMAND_NAMES, createProgram, runCli } from './cli.js';
export {
  type DiffRunner,
  type DiffRuntimeFactory,
  diffCommand,
  registerDiffCommand,
} from './commands/diff.js';
export {
  type InstallRunner,
  type InstallRuntimeFactory,
  installCommand,
  registerInstallCommand,
} from './commands/install.js';
export {
  registerStatusCommand,
  type StatusRunner,
  type StatusRuntimeFactory,
  statusCommand,
} from './commands/status.js';
export {
  registerUpdateCommand,
  type UpdateRunner,
  type UpdateRuntimeFactory,
  updateCommand,
} from './commands/update.js';
export {
  type DiffInput,
  type DiffItem,
  type DiffMetadata,
  type DiffReport,
  type DiffRuntime,
  diffProfile,
  type EffectiveMismatch,
} from './diff/engine.js';
export { EXIT_CODES, type ExitCode } from './exit-codes.js';
export { installPack } from './install/engine.js';
export {
  createNodeInstallRuntime,
  type NodeInstallRuntimeOptions,
} from './install/runtime.js';
export type {
  InstallInput,
  InstallReport,
  InstallReportMetadata,
  InstallRuntime,
} from './install/runtime-types.js';
export type {
  InstallDecision,
  InstallPlan,
  InstallPlanAsset,
  InstallPlanPlugin,
  InstallPlanWrite,
  InstallPreflightResult,
} from './install/types.js';
export {
  type RestoreDependencies,
  type RestoreInput,
  type RestoreMetadata,
  restoreProfile,
} from './restore/engine.js';
export {
  type StatusInput,
  type StatusMetadata,
  type StatusProfile,
  type StatusReport,
  statusProfiles,
} from './status/engine.js';
export * from './transaction.js';
export {
  type UninstallDependencies,
  type UninstallInput,
  type UninstallMetadata,
  uninstallProfile,
} from './uninstall/engine.js';
export {
  preflightUpdate,
  type UpdateInput,
  type UpdatePreflight,
  type UpdatePreflightResult,
  type UpdatePreflightSummary,
  type UpdateReport,
  type UpdateReportMetadata,
  type UpdateRuntime,
  updateProfile,
} from './update/engine.js';
export {
  type AuthorizationDelta,
  authorizationDelta,
  decideUpdateAuthorization,
  resolvedPluginIdentity,
  type UpdateAuthorizationDecision,
  type UpdateAuthorizationInput,
} from './update/policy.js';
