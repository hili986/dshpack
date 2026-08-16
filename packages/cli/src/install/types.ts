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

export interface InstallPlan {
  planVersion: 0;
  planDigest: string;
  manifestDigest: string;
  stateDigest: string;
  source: SourceProvenance;
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
  skills: readonly string[];
  presets: readonly string[];
  mcp: readonly string[];
  settingsNamespaces: readonly ['agent-presets'] | readonly [];
  writes: readonly InstallPlanWrite[];
  sideEffects: readonly InstallPlanSideEffect[];
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
  nonInteractiveCommand: string;
}

export interface InstallPreflightResult {
  diagnostics: readonly Diagnostic[];
  exitCode: ExitCode;
  plan?: InstallPlan;
  decision: InstallDecision;
}
