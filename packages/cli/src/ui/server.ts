import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { type Diagnostic, redactSecrets } from '@dshpack/core';

import { type CommandReport, diagnostic } from '../commands/shared.js';
import { diffProfile } from '../diff/engine.js';
import { runDoctor } from '../doctor/engine.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { runGc } from '../gc/engine.js';
import { installPack } from '../install/engine.js';
import { createNodeInstallRuntime } from '../install/runtime.js';
import type { InstallRuntime } from '../install/runtime-types.js';
import type { InstallPromptDecision } from '../install/types.js';
import { listProfiles } from '../list/engine.js';
import { restoreProfile } from '../restore/engine.js';
import { statusProfiles } from '../status/engine.js';
import { uninstallProfile } from '../uninstall/engine.js';
import { updateProfile } from '../update/engine.js';
import { composeAndInstall, previewCompose } from './compose.js';
import { editSkillContent, isSafeSkillId, readSkillContent } from './skills.js';
import type {
  UiDangerousPermission,
  UiJsonObject,
  UiRequest,
  UiWriteOperation,
  UiWriteRequest,
} from './wire.js';

const HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const UI_TOKEN_MARKER = '__DSHPACK_UI_TOKEN__';
const READ_OPERATIONS = new Set([
  'list',
  'status',
  'diff',
  'doctor',
  'composePreview',
  'skillContent',
]);
const WRITE_OPERATIONS = new Set([
  'install',
  'uninstall',
  'update',
  'restore',
  'gc',
  'compose',
  'editSkill',
]);
const FORBIDDEN_INPUT_KEYS = new Set([
  'allowBuilds',
  'allowDangerFullAccess',
  'allowUnverified',
  'allowVersionMismatch',
  'dryRun',
  'dshHome',
  'env',
  'fix',
  'interactive',
  'json',
  'yes',
]);

type EngineMetadata = Record<string, unknown>;
export type UiServerEngineReport = CommandReport<object>;

export interface UiServerReadInvocation {
  readonly operation: 'list' | 'status' | 'diff' | 'doctor' | 'composePreview' | 'skillContent';
  readonly input: Record<string, unknown> & { readonly dshHome: string };
}

export interface UiServerWriteInvocation {
  readonly operation: UiWriteOperation;
  readonly phase: 'plan' | 'apply';
  readonly input: Record<string, unknown> & { readonly dshHome: string };
  readonly authorizedDangerousPermissions: readonly UiDangerousPermission[];
}

export interface UiServerEngineRegistry {
  runRead(invocation: UiServerReadInvocation): Promise<UiServerEngineReport>;
  runWrite(invocation: UiServerWriteInvocation): Promise<UiServerEngineReport>;
}

/** Explicit assets for source-mode tests. Production uses the module-relative defaults. */
export interface UiServerUiAssets {
  readonly index: URL;
  readonly app: URL;
}

export interface UiServerOptions {
  readonly dshHome: string;
  readonly port?: number;
  readonly runtime?: InstallRuntime;
  readonly engines?: UiServerEngineRegistry;
  readonly maxBodyBytes?: number;
  readonly uiAssets?: UiServerUiAssets;
}

export interface UiServerHandle {
  readonly url: string;
  readonly token: string;
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly exitCode: ExitCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function digest(value: unknown): string {
  return `sha256-${createHash('sha256').update(canonical(value)).digest('base64url')}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function permission(value: unknown): value is UiDangerousPermission {
  if (!object(value) || typeof value.kind !== 'string' || typeof value.subject !== 'string')
    return false;
  switch (value.kind) {
    case 'allow-build':
    case 'danger-full-access':
    case 'unverified-source':
    case 'force':
    case 'purge-generations':
      return true;
    case 'new-plugin':
      return typeof value.identity === 'string';
    case 'version-mismatch':
      return Array.isArray(value.tested) && value.tested.every((item) => typeof item === 'string');
    default:
      return false;
  }
}

function exactInputKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, 'en'));
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validSkillInput(value: Record<string, unknown>): boolean {
  return typeof value.profile === 'string' && isSafeSkillId(value.skillId);
}

function validComposePreviewInput(value: Record<string, unknown>): boolean {
  return (
    exactInputKeys(value, ['spec']) &&
    typeof value.spec === 'object' &&
    value.spec !== null &&
    !Array.isArray(value.spec)
  );
}

function validComposeInput(value: Record<string, unknown>): boolean {
  return (
    (exactInputKeys(value, ['profile', 'spec']) ||
      exactInputKeys(value, ['profile', 'spec', 'allowUnknownLicense'])) &&
    typeof value.spec === 'object' &&
    value.spec !== null &&
    !Array.isArray(value.spec) &&
    typeof value.profile === 'string' &&
    (value.allowUnknownLicense === undefined || typeof value.allowUnknownLicense === 'boolean')
  );
}

function validOperationInput(operation: string, value: Record<string, unknown>): boolean {
  switch (operation) {
    case 'composePreview':
      return validComposePreviewInput(value);
    case 'compose':
      return validComposeInput(value);
    case 'skillContent':
      return exactInputKeys(value, ['profile', 'skillId']) && validSkillInput(value);
    case 'editSkill':
      return (
        validSkillInput(value) &&
        exactInputKeys(value, ['profile', 'skillId', 'content']) &&
        typeof value.content === 'string'
      );
    default:
      return true;
  }
}

function validateRequest(value: unknown): UiRequest {
  if (!object(value) || typeof value.operation !== 'string' || !object(value.input))
    throw new HttpRequestError(400, EXIT_CODES.USAGE, 'E_UI_REQUEST', 'Invalid UI request.');
  if ('yes' in value || Object.keys(value.input).some((key) => FORBIDDEN_INPUT_KEYS.has(key)))
    throw new HttpRequestError(
      400,
      EXIT_CODES.USAGE,
      'E_UI_REQUEST',
      'The UI wire request contains a forbidden authority field.',
    );
  if (!validOperationInput(value.operation, value.input))
    throw new HttpRequestError(
      400,
      EXIT_CODES.USAGE,
      'E_UI_REQUEST',
      'Invalid UI operation input.',
    );
  if (READ_OPERATIONS.has(value.operation)) {
    if ('phase' in value || 'authorizedDangerousPermissions' in value || 'planDigest' in value)
      throw new HttpRequestError(400, EXIT_CODES.USAGE, 'E_UI_REQUEST', 'Invalid read request.');
    return value as unknown as UiRequest;
  }
  if (!WRITE_OPERATIONS.has(value.operation))
    throw new HttpRequestError(400, EXIT_CODES.USAGE, 'E_UI_REQUEST', 'Unknown UI operation.');
  if (
    (value.phase !== 'plan' && value.phase !== 'apply') ||
    !Array.isArray(value.authorizedDangerousPermissions) ||
    !value.authorizedDangerousPermissions.every(permission)
  )
    throw new HttpRequestError(400, EXIT_CODES.USAGE, 'E_UI_REQUEST', 'Invalid write request.');
  if (value.phase === 'plan' && 'planDigest' in value)
    throw new HttpRequestError(
      400,
      EXIT_CODES.USAGE,
      'E_UI_REQUEST',
      'A plan cannot cite a digest.',
    );
  if (value.phase === 'apply' && typeof value.planDigest !== 'string')
    throw new HttpRequestError(
      400,
      EXIT_CODES.USAGE,
      'E_UI_REQUEST',
      'An apply request requires a plan digest.',
    );
  return value as unknown as UiRequest;
}

function authToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization);
    return match?.[1];
  }
  return new URL(request.url ?? '/', `http://${HOST}`).searchParams.get('token') ?? undefined;
}

function tokenMatches(expected: string, candidate: string | undefined): boolean {
  const known = Buffer.from(expected);
  const supplied = Buffer.from(candidate ?? '');
  if (known.length !== supplied.length) {
    timingSafeEqual(known, known);
    return false;
  }
  return timingSafeEqual(known, supplied);
}

async function readJson(request: IncomingMessage, maximum: number): Promise<unknown> {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximum)
    throw new HttpRequestError(413, EXIT_CODES.USAGE, 'E_UI_BODY_TOO_LARGE', 'Request too large.');
  const chunks: Buffer[] = [];
  let length = 0;
  let oversized = false;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.byteLength;
    if (length > maximum) oversized = true;
    else chunks.push(bytes);
  }
  if (oversized)
    throw new HttpRequestError(413, EXIT_CODES.USAGE, 'E_UI_BODY_TOO_LARGE', 'Request too large.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpRequestError(400, EXIT_CODES.USAGE, 'E_UI_JSON', 'Request body is not JSON.');
  }
}

function permissionKey(value: UiDangerousPermission): string {
  return canonical(value);
}

function uniquePermissions(
  values: readonly UiDangerousPermission[],
): readonly UiDangerousPermission[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = permissionKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function updatePermissions(metadata: EngineMetadata): readonly UiDangerousPermission[] {
  const preflight = object(metadata.preflight) ? metadata.preflight : undefined;
  const delta = Array.isArray(preflight?.authorizationDelta) ? preflight.authorizationDelta : [];
  return delta.flatMap((item): readonly UiDangerousPermission[] => {
    if (!object(item) || typeof item.kind !== 'string') return [];
    switch (item.kind) {
      case 'new-plugin':
        return typeof item.plugin === 'string' && typeof item.identity === 'string'
          ? [{ kind: 'new-plugin', subject: item.plugin, identity: item.identity }]
          : [];
      case 'allow-build':
        return typeof item.authorization === 'string'
          ? [{ kind: 'allow-build', subject: item.authorization }]
          : [];
      case 'danger-full-access':
        return [{ kind: 'danger-full-access', subject: 'danger-full-access' }];
      case 'version-mismatch':
        return typeof item.current === 'string' &&
          Array.isArray(item.tested) &&
          item.tested.every((value) => typeof value === 'string')
          ? [{ kind: 'version-mismatch', subject: item.current, tested: item.tested }]
          : [];
      default:
        return [];
    }
  });
}

function installPermissions(plan: Record<string, unknown>): readonly UiDangerousPermission[] {
  const result: UiDangerousPermission[] = [];
  const target = typeof plan.targetProfile === 'string' ? plan.targetProfile : 'install';
  const required = Array.isArray(plan.requiredDangerousPermissions)
    ? plan.requiredDangerousPermissions
    : [];
  if (required.includes('danger-full-access'))
    result.push({ kind: 'danger-full-access', subject: 'danger-full-access' });
  const dsh = object(plan.dsh) ? plan.dsh : undefined;
  if (dsh?.versionMismatch === true && typeof dsh.current === 'string')
    result.push({
      kind: 'version-mismatch',
      subject: dsh.current,
      tested: Array.isArray(dsh.tested)
        ? dsh.tested.filter((value): value is string => typeof value === 'string')
        : [],
    });
  if (Array.isArray(plan.plugins))
    for (const candidate of plan.plugins) {
      if (!object(candidate)) continue;
      const name = typeof candidate.name === 'string' ? candidate.name : target;
      if (candidate.allowBuilds === true) result.push({ kind: 'allow-build', subject: name });
      const integrity = object(candidate.integrity) ? candidate.integrity : undefined;
      if (integrity?.kind === 'unverified')
        result.push({ kind: 'unverified-source', subject: name });
    }
  return result;
}

function requestedOperationPermissions(
  operation: UiWriteOperation,
  input: Record<string, unknown>,
): readonly UiDangerousPermission[] {
  const subject =
    typeof input.profile === 'string'
      ? input.profile
      : typeof input.as === 'string'
        ? input.as
        : typeof input.source === 'string'
          ? input.source
          : operation;
  const values: UiDangerousPermission[] = [];
  if (input.force === true) values.push({ kind: 'force', subject });
  if (input.purgeGenerations === true) values.push({ kind: 'purge-generations', subject });
  return values;
}

function requiredPermissions(
  operation: UiWriteOperation,
  input: Record<string, unknown>,
  metadata: EngineMetadata,
): readonly UiDangerousPermission[] {
  const explicit = Array.isArray(metadata.requiredDangerousPermissions)
    ? metadata.requiredDangerousPermissions.filter(permission)
    : [];
  const plan = object(metadata.plan) ? metadata.plan : undefined;
  return uniquePermissions([
    ...explicit,
    ...((operation === 'install' || operation === 'compose') && plan !== undefined
      ? installPermissions(plan)
      : []),
    ...(operation === 'update' ? updatePermissions(metadata) : []),
    ...requestedOperationPermissions(operation, input),
  ]);
}

function calculatedPlanDigest(metadata: EngineMetadata): string {
  if (object(metadata.plan) && typeof metadata.plan.planDigest === 'string')
    return metadata.plan.planDigest;
  return digest(metadata);
}

function pinnedGitHubSource(value: unknown): string | undefined {
  if (
    !object(value) ||
    value.kind !== 'github' ||
    typeof value.owner !== 'string' ||
    typeof value.repo !== 'string' ||
    typeof value.commit !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.owner) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.repo) ||
    !/^[a-f0-9]{40}$/u.test(value.commit)
  )
    return undefined;
  return `github:${value.owner}/${value.repo}#${value.commit}`;
}

function frozenApplyInput(
  operation: UiWriteOperation,
  input: Record<string, unknown> & { readonly dshHome: string },
  metadata: EngineMetadata,
): Record<string, unknown> & { readonly dshHome: string } {
  const plan = object(metadata.plan) ? metadata.plan : undefined;
  if (operation === 'install') {
    const source = pinnedGitHubSource(plan?.source);
    return source === undefined ? input : { ...input, source };
  }
  if (operation === 'compose' && object(plan?.compose) && object(plan.compose.spec))
    return { ...input, spec: plan.compose.spec };
  return input;
}

function planPayload(metadata: EngineMetadata): UiJsonObject {
  return (object(metadata.plan) ? metadata.plan : metadata) as UiJsonObject;
}

function gatewayMetadata(
  engineMetadata: EngineMetadata,
  required: readonly UiDangerousPermission[],
  authorized: readonly UiDangerousPermission[],
  planDigest: string,
): EngineMetadata {
  const authorizedKeys = new Set(authorized.map(permissionKey));
  const missing = required.filter((item) => !authorizedKeys.has(permissionKey(item)));
  return {
    ...engineMetadata,
    requiredDangerousPermissions: required,
    authorizedDangerousPermissions: authorized,
    missingDangerousPermissions: missing,
    planDigest,
    plan: planPayload(engineMetadata),
  };
}

function gatewayDiagnostic(code: string, message: string): Diagnostic {
  return diagnostic(code, 'error', message, 'Review the current plan and retry.');
}

/**
 * The HTTP status answers one question: did the thing you asked for happen? For a `plan` it did —
 * a preview that reports what still needs authorizing is the normal flow, not a failure, and it
 * carries a non-zero exit code only to say "as configured this would not proceed". For a refused
 * `apply` nothing happened, and answering 200 would let a client that checks `response.ok` before
 * reading the body record an install that never ran. That is the same shape as the silent exit 0
 * this project already refuses elsewhere.
 */
interface UiDispatchedWrite {
  readonly report: UiServerEngineReport;
  readonly status: number;
}

async function dispatchWrite(
  request: UiWriteRequest,
  dshHome: string,
  engines: UiServerEngineRegistry,
): Promise<UiDispatchedWrite> {
  const input = { ...request.input, dshHome } as Record<string, unknown> & {
    readonly dshHome: string;
  };
  const authorization = uniquePermissions(request.authorizedDangerousPermissions);
  const planned = await engines.runWrite({
    operation: request.operation,
    phase: 'plan',
    input,
    authorizedDangerousPermissions: authorization,
  });
  if (planned.exitCode !== EXIT_CODES.SUCCESS) return { report: planned, status: 200 };
  const plannedMetadata = planned.metadata as EngineMetadata;
  const required = requiredPermissions(request.operation, input, plannedMetadata);
  const planDigest = calculatedPlanDigest(plannedMetadata);
  const metadata = gatewayMetadata(plannedMetadata, required, authorization, planDigest);
  const missing = metadata.missingDangerousPermissions as readonly UiDangerousPermission[];
  if (missing.length > 0)
    return {
      report: {
        diagnostics: [
          ...planned.diagnostics,
          gatewayDiagnostic(
            'E_UI_AUTHORIZATION_REQUIRED',
            'The current plan is missing one or more itemized authorizations.',
          ),
        ],
        exitCode: EXIT_CODES.USER_DECLINED,
        metadata,
      },
      // Only an apply was refused. The same body on a plan is the preview answering "here is what
      // you still have to authorize", which is the flow working, not failing.
      status: request.phase === 'apply' ? 403 : 200,
    };
  if (request.phase === 'plan') return { report: { ...planned, metadata }, status: 200 };
  if (request.planDigest !== planDigest)
    return {
      report: {
        diagnostics: [
          ...planned.diagnostics,
          gatewayDiagnostic(
            'E_UI_PLAN_CHANGED',
            'The current plan does not match the reviewed plan digest.',
          ),
        ],
        exitCode: EXIT_CODES.CONTRACT,
        metadata,
      },
      status: 409,
    };
  const applied = await engines.runWrite({
    operation: request.operation,
    phase: 'apply',
    input: frozenApplyInput(request.operation, input, plannedMetadata),
    authorizedDangerousPermissions: authorization,
  });
  return {
    report: {
      ...applied,
      metadata: gatewayMetadata(
        applied.metadata as EngineMetadata,
        required,
        authorization,
        planDigest,
      ),
    },
    status: 200,
  };
}

function inputStrings(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length >= 8 && value.length <= 256) output.add(value);
    for (const part of value.split(/[\\/]/u))
      if (part.length >= 8 && part.length <= 256) output.add(part);
    return;
  }
  if (Array.isArray(value)) for (const item of value) inputStrings(item, output);
  else if (object(value)) for (const item of Object.values(value)) inputStrings(item, output);
}

function redactionPatterns(values: readonly unknown[]): readonly string[] {
  const secrets = new Set<string>();
  for (const value of values) inputStrings(value, secrets);
  const patterns = new Set<string>();
  for (const secret of secrets) {
    patterns.add(secret);
    for (let index = 0; index <= secret.length - 8; index += 1)
      patterns.add(secret.slice(index, index + 8));
  }
  return [...patterns].sort((left, right) => right.length - left.length);
}

function redactText(value: string, patterns: readonly string[]): string {
  let output = value;
  for (const pattern of patterns) output = output.replaceAll(pattern, '[redacted]');
  output = redactSecrets(output);
  // A diagnostic may expose only a prefix of a token-like value. Remove that prefix too so an
  // eight-character slice cannot cross the transport boundary when the original input was not
  // available to the gateway.
  return output.replace(
    /\b(?:sk|ghp|gho|ghu|ghs|ghr|npm|xox[baprs]?)-[A-Za-z0-9_-]{8,}/giu,
    '[REDACTED]',
  );
}

function redactDiagnostics(
  diagnostics: readonly Diagnostic[],
  patterns: readonly string[],
): readonly Diagnostic[] {
  return diagnostics.map((item) => ({
    ...item,
    message: redactText(item.message, patterns),
    ...(item.hint === undefined ? {} : { hint: redactText(item.hint, patterns) }),
    ...(item.path === undefined ? {} : { path: redactText(item.path, patterns) }),
  }));
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  report: UiServerEngineReport,
): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(report));
}

type UiStaticAsset = 'index.html' | 'app.js';

const defaultUiAssets: UiServerUiAssets = {
  index: new URL('./ui/index.html', import.meta.url),
  app: new URL('./ui/app.js', import.meta.url),
};

function staticAsset(pathname: string): UiStaticAsset | undefined {
  if (pathname === '/') return 'index.html';
  if (pathname === '/ui/app.js') return 'app.js';
  return undefined;
}

function staticAssetUrl(asset: UiStaticAsset, assets: UiServerUiAssets): URL {
  // The request pathname maps to a finite asset union, so no client-controlled path can reach the
  // filesystem. `assets` is supplied only when a direct server caller deliberately injects a
  // fixture; ordinary CLI use always resolves the module-relative bundle above.
  return asset === 'index.html' ? assets.index : assets.app;
}

async function readStaticAsset(asset: UiStaticAsset, assets: UiServerUiAssets): Promise<Buffer> {
  // The bundle is shipped with its sibling `ui/` directory. Keeping the lookup module-relative
  // also makes the server independent of the process launch directory.
  return readFile(staticAssetUrl(asset, assets));
}

function staticResponse(
  response: ServerResponse,
  asset: UiStaticAsset,
  body: Buffer | string,
): void {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type':
      asset === 'index.html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function errorReport(error: HttpRequestError): UiServerEngineReport {
  return {
    diagnostics: [diagnostic(error.code, 'error', error.message, 'Correct the request and retry.')],
    exitCode: error.exitCode,
    metadata: {},
  };
}

function permissionFlag(
  permissions: readonly UiDangerousPermission[],
  kind: UiDangerousPermission['kind'],
): boolean {
  return permissions.some((item) => item.kind === kind);
}

function engineInput(invocation: UiServerWriteInvocation): Record<string, unknown> {
  const { authorizedDangerousPermissions: permissions } = invocation;
  return {
    ...invocation.input,
    dryRun: invocation.phase === 'plan',
    ...(invocation.phase === 'apply' ? { yes: true } : {}),
    allowBuilds: permissions
      .filter((item) => item.kind === 'allow-build')
      .map((item) => item.subject),
    allowDangerFullAccess: permissionFlag(permissions, 'danger-full-access'),
    allowUnverified: permissionFlag(permissions, 'unverified-source'),
    allowVersionMismatch: permissionFlag(permissions, 'version-mismatch'),
    interactive: invocation.phase === 'apply',
    json: invocation.phase === 'plan',
  };
}

/**
 * Exported for tests only — not re-exported from the package index. The gateway's itemized check
 * makes this the second of two independent gates, so no end-to-end request can distinguish a
 * strict match from a loose one today. That is precisely why it needs a direct test: a rule whose
 * correctness rests on another layer being right is a rule nobody is checking.
 */
export function promptAuthorized(
  prompt: InstallPromptDecision,
  permissions: readonly UiDangerousPermission[],
): boolean {
  // Submitting the operation is the answer to "do you want to do this at all"; everything
  // dangerous is itemized below and answered only by a matching grant.
  if (prompt.kind === 'install' || prompt.kind === 'update') return true;
  return permissions.some((item) => {
    if (item.kind !== prompt.kind) return false;
    // These two carry no discriminator. There is at most one of each per plan, and the prompt
    // subject is a rendered sentence (`0.1.0-rc.5 ∉ dsh.tested`) rather than an identifier, so the
    // kind is the whole match. Comparing subjects here would fail closed against the gateway's
    // structured form, which stores the version alone.
    if (item.kind === 'danger-full-access' || item.kind === 'version-mismatch') return true;
    // Everything else names a package, and the name must match exactly. A substring rule would let
    // a grant for `foo` answer a prompt for `foo-core` — the implicit escalation SECURITY.md
    // promises does not happen: "父包、scope、或某个已授权的依赖，都不会把权限隐式传递出去".
    //
    // The gateway's itemized check already refuses a plan whose required set is not covered, so
    // reaching here with an unmatched name means the two derivations disagreed. That is exactly
    // when the loose rule would do damage and the strict one fails closed.
    return prompt.subject === item.subject;
  });
}

function authorizedRuntime(
  runtime: InstallRuntime,
  permissions: readonly UiDangerousPermission[],
): InstallRuntime {
  return {
    ...runtime,
    confirm: async (prompt) => promptAuthorized(prompt, permissions),
    writeStderr: () => undefined,
  };
}

function defaultEngines(dshHome: string, suppliedRuntime?: InstallRuntime): UiServerEngineRegistry {
  const runtime = suppliedRuntime ?? createNodeInstallRuntime(dshHome);
  return {
    async runRead({ operation, input }) {
      switch (operation) {
        case 'list':
          return listProfiles(input as { dshHome: string });
        case 'status':
          return statusProfiles(input as { dshHome: string; checkUpdates?: boolean }, runtime);
        case 'diff':
          return diffProfile(
            input as { dshHome: string; profile: string; to?: string; checkUpdates?: boolean },
            runtime,
          );
        case 'doctor':
          return runDoctor(
            {
              ...(input as { dshHome: string; profile?: string; strict?: boolean }),
              skipDshHost: true,
            },
            {
              // Profile dump checks can materialize cordis.yml. The UI read surface skips the
              // dsh host probes (honest info diagnostic) and keeps the rejecting runner as a
              // defense-in-depth backstop should a probe ever be added without the skip flag.
              runDsh: async () => Promise.reject(new Error('UI doctor is read-only.')),
            },
          );
        case 'composePreview':
          return previewCompose(
            dshHome,
            input as unknown as { spec: Parameters<typeof previewCompose>[1]['spec'] },
          );
        case 'skillContent':
          return readSkillContent(
            dshHome,
            input as unknown as { profile: string; skillId: string },
          );
      }
    },
    async runWrite(invocation) {
      const input = engineInput(invocation);
      const gatedRuntime = authorizedRuntime(runtime, invocation.authorizedDangerousPermissions);
      switch (invocation.operation) {
        case 'install':
          return installPack(input as unknown as Parameters<typeof installPack>[0], gatedRuntime);
        case 'uninstall':
          return uninstallProfile(input as unknown as Parameters<typeof uninstallProfile>[0]);
        case 'update':
          return updateProfile(
            input as unknown as Parameters<typeof updateProfile>[0],
            gatedRuntime,
          );
        case 'restore':
          return restoreProfile(input as unknown as Parameters<typeof restoreProfile>[0]);
        case 'gc':
          return runGc(input as unknown as Parameters<typeof runGc>[0]);
        case 'compose':
          return composeAndInstall(
            dshHome,
            input as {
              profile: string;
              spec: Parameters<typeof composeAndInstall>[1]['spec'];
              allowUnknownLicense?: boolean;
            },
            gatedRuntime,
            invocation.phase,
          );
        case 'editSkill':
          return editSkillContent(
            dshHome,
            input as { profile: string; skillId: string; content: string },
            invocation.phase,
          );
        default:
          throw new Error(`Unsupported UI write operation: ${invocation.operation}`);
      }
    },
  };
}

/** Start a per-process, token-protected HTTP transport for direct engine calls. */
export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const token = randomBytes(32).toString('base64url');
  const engines = options.engines ?? defaultEngines(options.dshHome, options.runtime);
  const maximum = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const uiAssets = options.uiAssets ?? defaultUiAssets;
  const server = createServer(async (request, response) => {
    let parsed: unknown;
    try {
      if (!tokenMatches(token, authToken(request)))
        throw new HttpRequestError(401, EXIT_CODES.SECURITY, 'E_UI_AUTH', 'UI token rejected.');
      const url = new URL(request.url ?? '/', `http://${HOST}`);
      const asset = staticAsset(url.pathname);
      if (asset !== undefined) {
        if (request.method !== 'GET')
          throw new HttpRequestError(405, EXIT_CODES.USAGE, 'E_UI_METHOD', 'Method not allowed.');
        const bytes = await readStaticAsset(asset, uiAssets);
        if (asset === 'index.html') {
          const html = bytes
            .toString('utf8')
            .replaceAll(UI_TOKEN_MARKER, encodeURIComponent(token));
          staticResponse(response, asset, html);
        } else {
          staticResponse(response, asset, bytes);
        }
        return;
      }
      if (url.pathname !== '/api')
        throw new HttpRequestError(404, EXIT_CODES.USAGE, 'E_UI_ROUTE', 'Unknown UI route.');
      if (request.method !== 'POST')
        throw new HttpRequestError(405, EXIT_CODES.USAGE, 'E_UI_METHOD', 'Method not allowed.');
      parsed = await readJson(request, maximum);
      const wire = validateRequest(parsed);
      const dispatched: UiDispatchedWrite = READ_OPERATIONS.has(wire.operation)
        ? {
            report: await engines.runRead({
              operation: wire.operation as UiServerReadInvocation['operation'],
              input: { ...wire.input, dshHome: options.dshHome },
            }),
            // A read that fails still answered the question it was asked; nothing was going to
            // change either way, so there is no success to mistake it for.
            status: 200,
          }
        : await dispatchWrite(wire as UiWriteRequest, options.dshHome, engines);
      const patterns = redactionPatterns([token, options.dshHome, parsed]);
      jsonResponse(response, dispatched.status, {
        ...dispatched.report,
        diagnostics: redactDiagnostics(dispatched.report.diagnostics, patterns),
      });
    } catch (error) {
      const failure =
        error instanceof HttpRequestError
          ? error
          : new HttpRequestError(
              500,
              EXIT_CODES.INTERNAL,
              'E_UI_INTERNAL',
              'The UI request failed internally.',
            );
      const patterns = redactionPatterns([token, options.dshHome, parsed]);
      const report = errorReport(failure);
      jsonResponse(response, failure.status, {
        ...report,
        diagnostics: redactDiagnostics(report.diagnostics, patterns),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(options.port ?? 0, HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('UI server did not bind a TCP address.');
  }
  let closePromise: Promise<void> | undefined;
  return {
    server,
    token,
    port: address.port,
    url: `http://${HOST}:${address.port}/?token=${encodeURIComponent(token)}`,
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (
            error !== undefined &&
            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
          )
            reject(error);
          else resolve();
        });
      });
      return closePromise;
    },
  };
}
