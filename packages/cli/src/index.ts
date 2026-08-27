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
  type ComposeRunner,
  composeCommand,
  registerComposeCommand,
} from './commands/compose.js';
export {
  type DiffRunner,
  type DiffRuntimeFactory,
  diffCommand,
  registerDiffCommand,
} from './commands/diff.js';
export {
  initCommand,
  registerInitCommand,
} from './commands/init.js';
export {
  type InstallRunner,
  type InstallRuntimeFactory,
  installCommand,
  registerInstallCommand,
} from './commands/install.js';
export {
  type PackRunner,
  packCommand,
  registerPackCommand,
} from './commands/pack.js';
export type { CommandReport } from './commands/shared.js';
export {
  registerStatusCommand,
  type StatusRunner,
  type StatusRuntimeFactory,
  statusCommand,
} from './commands/status.js';
export {
  openUiBrowser,
  registerUiCommand,
  type UiBrowserChild,
  type UiBrowserOpener,
  type UiBrowserRuntime,
  type UiCommandDependencies,
  type UiCommandServerHandle,
  type UiCommandServerOptions,
  type UiServerStarter,
  type UiShutdownSignal,
  type UiSignalRuntime,
  uiCommand,
} from './commands/ui.js';
export {
  registerUpdateCommand,
  type UpdateRunner,
  type UpdateRuntimeFactory,
  updateCommand,
} from './commands/update.js';
export {
  type ComposeDependencies,
  type ComposeInput,
  type ComposeMaterializedSource,
  type ComposeMetadata,
  type ComposeReport,
  composePack,
} from './compose/engine.js';
export {
  type DiffInput,
  type DiffItem,
  type DiffMetadata,
  type DiffReport,
  type DiffRuntime,
  diffProfile,
  type EffectiveMismatch,
} from './diff/engine.js';
export {
  type DoctorDependencies,
  type DoctorInput,
  type DoctorMetadata,
  type DoctorReport,
  runDoctor,
} from './doctor/engine.js';
export { EXIT_CODES, type ExitCode } from './exit-codes.js';
export {
  type GcDependencies,
  type GcInput,
  type GcMetadata,
  type GcReport,
  runGc,
} from './gc/engine.js';
export {
  type InitDependencies,
  type InitInput,
  type InitMetadata,
  type InitReport,
  type InitTemplate,
  initializePack,
} from './init/engine.js';
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
  type ListedProfile,
  type ListInput,
  type ListMetadata,
  type ListReport,
  listProfiles,
  type ProfileStatus,
} from './list/engine.js';
export {
  generateAndWriteLock,
  generateLock,
  type LockInput,
  type LockMetadata,
  type LockOptions,
  type LockReport,
} from './lock/engine.js';
export {
  type MigrateInput,
  type MigrateMetadata,
  type MigrateReport,
  type MigrateRuntime,
  migrateProfile,
} from './migrate/engine.js';
export {
  type PackedFile,
  type PackInput,
  type PackMetadata,
  type PackReport,
  packDirectory,
} from './pack/engine.js';
export {
  type RestoreDependencies,
  type RestoreInput,
  type RestoreMetadata,
  type RestoreReport,
  restoreProfile,
} from './restore/engine.js';
export {
  type StatusInput,
  type StatusMetadata,
  type StatusProfile,
  type StatusReport,
  statusProfiles,
} from './status/engine.js';
export {
  nodeSwitchRuntime,
  type SwitchInput,
  type SwitchMetadata,
  type SwitchReport,
  type SwitchRuntime,
  switchProfile,
} from './switch/engine.js';
export * from './transaction.js';
export {
  startUiServer,
  type UiServerEngineRegistry,
  type UiServerEngineReport,
  type UiServerHandle,
  type UiServerOptions,
  type UiServerReadInvocation,
  type UiServerWriteInvocation,
} from './ui/server.js';
export type {
  UiApplyRequest,
  UiComposeInput,
  UiComposePreviewInput,
  UiComposePreviewRequest,
  UiComposeRequest,
  UiComposeSpec,
  UiDangerousPermission,
  UiDiffInput,
  UiDiffRequest,
  UiDoctorInput,
  UiDoctorRequest,
  UiEditSkillInput,
  UiEditSkillRequest,
  UiGcInput,
  UiGcRequest,
  UiInstallInput,
  UiInstallRequest,
  UiJsonObject,
  UiJsonPrimitive,
  UiJsonValue,
  UiListInput,
  UiListRequest,
  UiPlanRequest,
  UiReadRequest,
  UiRequest,
  UiResponse,
  UiResponseMetadata,
  UiRestoreInput,
  UiRestoreRequest,
  UiSkillContentInput,
  UiSkillContentRequest,
  UiStatusInput,
  UiStatusRequest,
  UiUninstallInput,
  UiUninstallRequest,
  UiUpdateInput,
  UiUpdateRequest,
  UiWriteOperation,
  UiWriteRequest,
} from './ui/wire.js';
export {
  type UninstallDependencies,
  type UninstallInput,
  type UninstallMetadata,
  type UninstallReport,
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
