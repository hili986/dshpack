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
export { EXIT_CODES, type ExitCode } from './exit-codes.js';
export * from './transaction.js';
