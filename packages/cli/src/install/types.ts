import type { Diagnostic, PackManifest } from '@dshpack/core';

import type { SourceProvenance } from '../adapters/source.js';
import type { ExitCode } from '../exit-codes.js';

export type EffectiveAt = '重启生效' | '新会话生效' | '仅空白会话' | '热生效';
export type DangerousPermission = 'danger-full-access';

export interface InstallPlanPlugin {
  name: string;
  source: PackManifest['plugins'][number]['source'];
  exactSpec: string;
  integrity:
    | { kind: 'npm-sri'; value: string }
    | { kind: 'git-commit'; value: string }
    | { kind: 'sha512'; value: string }
    | { kind: 'unverified'; reason: string };
  allowBuilds: boolean;
  expectedPackageJsonSha512: string;
  expectedBundlePatch: string;
  effectiveAt: '重启生效';
}

export interface InstallPlanWrite {
  path: string;
  kind: 'profile' | 'skill' | 'preset' | 'settings' | 'metadata';
  policy: 'create-or-replace' | 'skip-existing' | 'merge' | 'transactional';
  effectiveAt: EffectiveAt;
}

export interface InstallPlanSideEffect {
  path: string;
  reason: string;
}

export interface InstallPlanSourceFile {
  path: string;
  sha512: string;
}

export type InstallPathBeforeState =
  | { path: string; state: 'absent' }
  | { path: string; state: 'present'; sha256: string };

export interface InstallTargetBeforeState {
  profile: InstallPathBeforeState;
  skills: readonly InstallPathBeforeState[];
  presets: readonly InstallPathBeforeState[];
  settings: InstallPathBeforeState;
}

export interface InstallPlanAsset {
  id: string;
  source: string;
  target: string;
  collision: boolean;
  action: 'create' | 'skip' | 'replace';
  effectiveAt: '热生效' | '新会话生效';
}

export interface InstallPlanMcp {
  serverName: string;
  transport: 'streamable-http';
  source: string;
  target: 'profile patch';
  action: 'configure';
  effectiveAt: '重启生效';
}

export interface InstallPlanDefaults {
  agentPreset?: {
    value: string;
    source: 'pack' | 'environment';
    effectiveAt: '仅空白会话';
  };
  permissionPreset: {
    value: 'workspace-write' | 'danger-full-access';
    effectiveAt: '仅空白会话';
  };
}

export interface InstallPlan {
  planVersion: 0;
  planDigest: string;
  manifestDigest: string;
  lockDigest: string;
  sourceFiles: readonly InstallPlanSourceFile[];
  stateDigest: string;
  source: SourceProvenance;
  dshHome: string;
  pack: { name: string; version: string };
  targetProfile: string;
  replaceExistingProfile: boolean;
  frozen: true;
  dsh: {
    current: string;
    tested: readonly string[];
    versionMismatch: boolean;
  };
  pnpm: { current: string };
  plugins: readonly InstallPlanPlugin[];
  allowBuilds: readonly string[];
  extraBuildApprovals: readonly string[];
  skills: readonly InstallPlanAsset[];
  presets: readonly InstallPlanAsset[];
  mcp: readonly InstallPlanMcp[];
  defaults: InstallPlanDefaults;
  settingsNamespaces: readonly {
    namespace: 'agent-presets';
    source: 'settings/agent-presets.yml';
    target: 'settings.yaml#agent-presets';
    action: 'merge';
    effectiveAt: '新会话生效';
  }[];
  writes: readonly InstallPlanWrite[];
  sideEffects: readonly InstallPlanSideEffect[];
  beforeState: InstallTargetBeforeState;
  rollbackSnapshot: { enabled: true; targetBeforeStateDigest: string };
  requiredDangerousPermissions: readonly DangerousPermission[];
  authorizedDangerousPermissions: readonly DangerousPermission[];
}

export interface InstallPlanOptions {
  sourceArgument: string;
  as?: string;
  replace?: boolean;
  frozen?: boolean;
  dryRun?: boolean;
  force?: boolean;
  yes?: boolean;
  allowBuilds?: readonly string[];
  allowUnverified?: boolean;
  allowVersionMismatch?: boolean;
  allowDangerFullAccess?: boolean;
}

export interface InstallEnvironmentFacts {
  dshHome: string;
  dshVersion: string;
  pnpmVersion: string;
  profileExists: boolean;
  interactive: boolean;
  targetBeforeState: InstallTargetBeforeState;
  targetBeforeStateDigest: string;
  availableAgentPresets?: readonly string[];
}

export interface PrepareInstallPlanInput {
  source: { directory: string; provenance: SourceProvenance };
  options: InstallPlanOptions;
  environment: InstallEnvironmentFacts;
}

export type InstallPromptKind =
  | 'install'
  | 'allow-build'
  | 'danger-full-access'
  | 'version-mismatch';

export interface InstallPromptDecision {
  kind: InstallPromptKind;
  subject: string;
  defaultValue: false;
}

export interface InstallDecision {
  status: 'ready' | 'requires-interaction' | 'review-only' | 'rejected';
  prompts: readonly InstallPromptDecision[];
  missingAllowBuilds: readonly string[];
  nonInteractiveArgv: readonly string[];
  nonInteractiveCommand: string;
}

export interface InstallPreflightResult {
  diagnostics: readonly Diagnostic[];
  exitCode: ExitCode;
  plan?: InstallPlan;
  decision: InstallDecision;
}
