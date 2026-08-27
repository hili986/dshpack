import type { Diagnostic } from '@dshpack/core';

import type { DiffInput } from '../diff/engine.js';
import type { DoctorInput } from '../doctor/engine.js';
import type { ExitCode } from '../exit-codes.js';
import type { GcInput } from '../gc/engine.js';
import type { InstallInput } from '../install/runtime-types.js';
import type { RestoreInput } from '../restore/engine.js';
import type { StatusInput } from '../status/engine.js';
import type { UninstallInput } from '../uninstall/engine.js';
import type { UpdateInput } from '../update/engine.js';

export type UiJsonPrimitive = boolean | number | string | null;
export type UiJsonValue =
  | UiJsonPrimitive
  | readonly UiJsonValue[]
  | { readonly [key: string]: UiJsonValue };
export type UiJsonObject = { readonly [key: string]: UiJsonValue };

export type UiDangerousPermission =
  | { readonly kind: 'allow-build'; readonly subject: string }
  | { readonly kind: 'danger-full-access'; readonly subject: string }
  | {
      readonly kind: 'version-mismatch';
      readonly subject: string;
      readonly tested: readonly string[];
    }
  | { readonly kind: 'unverified-source'; readonly subject: string }
  | {
      readonly kind: 'new-plugin';
      readonly subject: string;
      readonly identity: string;
    }
  | { readonly kind: 'force'; readonly subject: string }
  | { readonly kind: 'purge-generations'; readonly subject: string };

export type UiListInput = {
  readonly [key: string]: never;
};
export type UiStatusInput = Omit<StatusInput, 'dshHome'>;
export type UiDiffInput = Omit<DiffInput, 'dshHome'>;
export type UiDoctorInput = Pick<DoctorInput, 'profile' | 'strict'>;
/** The browser submits compose.yml's validated document shape, never a file path. */
export interface UiComposeSpec {
  readonly composeVersion: 0;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly license: string;
  readonly include: readonly { readonly from: string; readonly skills: readonly string[] }[];
  readonly resolve?: readonly {
    readonly id: string;
    readonly rename?: string;
    readonly prefer?: string;
  }[];
  readonly mcp?: readonly {
    readonly serverName: string;
    readonly transport: 'streamable-http';
    readonly url: string;
  }[];
  readonly defaults: { readonly permissionPreset: 'workspace-write' | 'danger-full-access' };
}
export interface UiComposePreviewInput {
  readonly spec: UiComposeSpec;
}
export interface UiSkillContentInput {
  readonly profile: string;
  readonly skillId: string;
}

export interface UiListRequest {
  readonly operation: 'list';
  readonly input: UiListInput;
}

export interface UiStatusRequest {
  readonly operation: 'status';
  readonly input: UiStatusInput;
}

export interface UiDiffRequest {
  readonly operation: 'diff';
  readonly input: UiDiffInput;
}

export interface UiDoctorRequest {
  readonly operation: 'doctor';
  readonly input: UiDoctorInput;
}

export interface UiComposePreviewRequest {
  readonly operation: 'composePreview';
  readonly input: UiComposePreviewInput;
}

export interface UiSkillContentRequest {
  readonly operation: 'skillContent';
  readonly input: UiSkillContentInput;
}

export type UiReadRequest =
  | UiListRequest
  | UiStatusRequest
  | UiDiffRequest
  | UiDoctorRequest
  | UiComposePreviewRequest
  | UiSkillContentRequest;

export type UiInstallInput = Pick<InstallInput, 'source' | 'as' | 'replace' | 'frozen' | 'force'>;
export type UiUninstallInput = Pick<
  UninstallInput,
  'profile' | 'keepAssets' | 'force' | 'purgeGenerations'
>;
export type UiUpdateInput = Pick<UpdateInput, 'profile' | 'to' | 'ours' | 'theirs' | 'only'>;
export type UiRestoreInput = Pick<RestoreInput, 'profile' | 'to' | 'force'>;
export type UiGcInput = Omit<GcInput, 'dshHome' | 'dryRun'>;
export interface UiComposeInput {
  readonly profile: string;
  readonly spec: UiComposeSpec;
}
export interface UiEditSkillInput extends UiSkillContentInput {
  readonly content: string;
}

export type UiWriteOperation =
  | 'install'
  | 'uninstall'
  | 'update'
  | 'restore'
  | 'gc'
  | 'compose'
  | 'editSkill';

interface UiWriteRequestBase<Operation extends UiWriteOperation, Input extends object> {
  readonly operation: Operation;
  readonly input: Input;
  readonly authorizedDangerousPermissions: readonly UiDangerousPermission[];
}

export type UiPlanRequest<
  Operation extends UiWriteOperation,
  Input extends object,
> = UiWriteRequestBase<Operation, Input> & {
  readonly phase: 'plan';
  readonly planDigest?: never;
};

export type UiApplyRequest<
  Operation extends UiWriteOperation,
  Input extends object,
> = UiWriteRequestBase<Operation, Input> & {
  readonly phase: 'apply';
  readonly planDigest: string;
};

type UiPhasedWriteRequest<Operation extends UiWriteOperation, Input extends object> =
  | UiPlanRequest<Operation, Input>
  | UiApplyRequest<Operation, Input>;

export type UiInstallRequest = UiPhasedWriteRequest<'install', UiInstallInput>;
export type UiUninstallRequest = UiPhasedWriteRequest<'uninstall', UiUninstallInput>;
export type UiUpdateRequest = UiPhasedWriteRequest<'update', UiUpdateInput>;
export type UiRestoreRequest = UiPhasedWriteRequest<'restore', UiRestoreInput>;
export type UiGcRequest = UiPhasedWriteRequest<'gc', UiGcInput>;
export type UiComposeRequest = UiPhasedWriteRequest<'compose', UiComposeInput>;
export type UiEditSkillRequest = UiPhasedWriteRequest<'editSkill', UiEditSkillInput>;

export type UiWriteRequest =
  | UiInstallRequest
  | UiUninstallRequest
  | UiUpdateRequest
  | UiRestoreRequest
  | UiGcRequest
  | UiComposeRequest
  | UiEditSkillRequest;

export type UiRequest = UiReadRequest | UiWriteRequest;

export type UiResponseMetadata = {
  readonly [key: string]: UiJsonValue | undefined;
  readonly requiredDangerousPermissions?: readonly UiDangerousPermission[];
  readonly authorizedDangerousPermissions?: readonly UiDangerousPermission[];
  readonly missingDangerousPermissions?: readonly UiDangerousPermission[];
  readonly planDigest?: string;
  readonly plan?: UiJsonObject;
};

export interface UiResponse<Metadata extends object = UiResponseMetadata> {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: ExitCode;
  readonly metadata: Metadata;
}
