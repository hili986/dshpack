import type {
  UiDangerousPermission,
  UiJsonObject,
  UiRequest,
  UiResponse,
  UiWriteRequest,
} from 'dshpack';

import type { Locale } from './messages.js';

/** The browser owns only this small, explicit lifecycle. */
export type BrowserPhase =
  | 'idle'
  | 'planning'
  | 'reviewing'
  | 'applying'
  | 'done'
  | 'stale'
  | 'failed';

export interface BrowserLocaleState {
  readonly locale: Locale;
}

export interface BrowserIdleState extends BrowserLocaleState {
  readonly phase: 'idle';
}

export interface BrowserPlanningState extends BrowserLocaleState {
  readonly phase: 'planning';
  readonly operation: UiWriteRequest['operation'];
  readonly input: UiWriteRequest['input'];
  readonly request: UiWriteRequest;
  readonly error?: UiResponse;
}

export interface BrowserReviewFields extends BrowserLocaleState {
  readonly operation: UiWriteRequest['operation'];
  readonly input: UiWriteRequest['input'];
  readonly request: UiWriteRequest;
  readonly plan: UiJsonObject;
  readonly planDigest: string;
  readonly required: readonly UiDangerousPermission[];
  readonly granted: readonly UiDangerousPermission[];
  readonly missing: readonly UiDangerousPermission[];
  /** A 403 marks only the server-reported items; it never mutates `granted`. */
  readonly highlightedMissing: readonly UiDangerousPermission[];
  readonly dangerConfirmed: boolean;
  readonly error?: UiResponse;
  readonly report?: UiResponse;
}

export interface BrowserReviewingState extends BrowserReviewFields {
  readonly phase: 'reviewing';
}

export interface BrowserApplyingState extends BrowserReviewFields {
  readonly phase: 'applying';
}

export interface BrowserDoneState extends BrowserReviewFields {
  readonly phase: 'done';
  readonly report: UiResponse;
}

export interface BrowserStaleState extends BrowserReviewFields {
  readonly phase: 'stale';
  readonly granted: readonly [];
  readonly dangerConfirmed: false;
  readonly error: UiResponse;
}

export interface BrowserFailedState extends BrowserLocaleState {
  readonly phase: 'failed';
  readonly operation: UiWriteRequest['operation'];
  readonly input: UiWriteRequest['input'];
  readonly request: UiWriteRequest;
  readonly error: UiResponse;
  readonly report: UiResponse;
}

export type BrowserState =
  | BrowserIdleState
  | BrowserPlanningState
  | BrowserReviewingState
  | BrowserApplyingState
  | BrowserDoneState
  | BrowserStaleState
  | BrowserFailedState;

export type BrowserPlanAction = {
  readonly type: 'plan';
  readonly request: UiRequest;
};

export type BrowserGrantAction = {
  readonly type: 'grant';
  readonly permission: UiDangerousPermission;
  readonly granted?: boolean;
};

export type BrowserConfirmDangerAction = {
  readonly type: 'confirm-danger-full-access';
  readonly confirmed?: boolean;
};

export type BrowserResponseAction = {
  readonly type: 'response' | 'plan-success' | 'plan-response' | 'apply-response';
  readonly response: UiResponse;
  readonly httpStatus?: number;
  readonly status?: number;
};

export type BrowserApplyAction = { readonly type: 'apply' };
export type BrowserResetAction = { readonly type: 'reset' };
export type BrowserSetLocaleAction = { readonly type: 'set-locale'; readonly locale: Locale };

interface BrowserUnknownAction {
  readonly type: string;
  readonly request?: UiRequest;
  readonly permission?: UiDangerousPermission;
  readonly granted?: boolean;
  readonly confirmed?: boolean;
  readonly response?: UiResponse;
  readonly httpStatus?: number;
  readonly status?: number;
  readonly [key: string]: unknown;
}

/**
 * The index signature intentionally permits transport adapters to add harmless envelope fields.
 * Unknown action names are ignored, so a stale or malicious client cannot advance the machine.
 */
export type BrowserAction =
  | BrowserPlanAction
  | BrowserGrantAction
  | BrowserConfirmDangerAction
  | BrowserResponseAction
  | BrowserApplyAction
  | BrowserResetAction
  | BrowserSetLocaleAction
  | BrowserUnknownAction;

export const createBrowserState = (): BrowserIdleState => ({ phase: 'idle', locale: 'zh' });
export const createInitialState = createBrowserState;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function permission(value: unknown): value is UiDangerousPermission {
  if (!record(value) || typeof value.kind !== 'string' || typeof value.subject !== 'string')
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

function uniquePermissions(
  values: readonly UiDangerousPermission[],
): readonly UiDangerousPermission[] {
  const unique: UiDangerousPermission[] = [];
  for (const value of values)
    if (!unique.some((current) => permissionEquals(current, value))) unique.push(value);
  return unique;
}

function permissions(value: unknown): readonly UiDangerousPermission[] {
  return Array.isArray(value)
    ? uniquePermissions(value.filter((item): item is UiDangerousPermission => permission(item)))
    : [];
}

export function permissionEquals(
  left: UiDangerousPermission,
  right: UiDangerousPermission,
): boolean {
  if (left.kind !== right.kind || left.subject !== right.subject) return false;
  if (left.kind === 'new-plugin' && right.kind === 'new-plugin')
    return left.identity === right.identity;
  if (left.kind === 'version-mismatch' && right.kind === 'version-mismatch')
    return (
      left.tested.length === right.tested.length &&
      left.tested.every((value, index) => value === right.tested[index])
    );
  return true;
}

function hasPermission(
  values: readonly UiDangerousPermission[],
  candidate: UiDangerousPermission,
): boolean {
  return values.some((value) => permissionEquals(value, candidate));
}

function permissionsEqual(
  left: readonly UiDangerousPermission[],
  right: readonly UiDangerousPermission[],
): boolean {
  return left.length === right.length && left.every((value) => hasPermission(right, value));
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((value, index) => jsonEquals(value, right[index]))
    );
  if (!record(left) || !record(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key], right[key]))
  );
}

function jsonObject(value: unknown): UiJsonObject {
  return record(value) ? (value as UiJsonObject) : {};
}

function reportMetadata(response: UiResponse): Record<string, unknown> {
  return record(response.metadata) ? response.metadata : {};
}

function planFrom(response: UiResponse): UiJsonObject {
  return jsonObject(reportMetadata(response).plan);
}

function digestFrom(response: UiResponse, plan: UiJsonObject): string {
  const metadata = reportMetadata(response);
  if (typeof metadata.planDigest === 'string') return metadata.planDigest;
  if (typeof plan.planDigest === 'string') return plan.planDigest;
  return '';
}

function requiredFrom(response: UiResponse): readonly UiDangerousPermission[] {
  return permissions(reportMetadata(response).requiredDangerousPermissions);
}

function missingFrom(response: UiResponse): readonly UiDangerousPermission[] {
  return permissions(reportMetadata(response).missingDangerousPermissions);
}

function isWriteRequest(value: UiRequest): value is UiWriteRequest {
  return (
    record(value) &&
    typeof value.operation === 'string' &&
    value.operation !== 'list' &&
    value.operation !== 'status' &&
    value.operation !== 'diff' &&
    value.operation !== 'doctor' &&
    (value as Record<string, unknown>).phase === 'plan'
  );
}

function planRequest(value: UiRequest): UiWriteRequest | undefined {
  if (isWriteRequest(value)) return value;
  return undefined;
}

function reviewFromPlan(
  request: UiWriteRequest,
  response: UiResponse,
  locale: Locale,
  highlightedMissing: readonly UiDangerousPermission[] = [],
): BrowserReviewingState {
  const plan = planFrom(response);
  const required = requiredFrom(response);
  const reportedMissing = missingFrom(response);
  const missing = reportedMissing.length > 0 ? reportedMissing : required;
  return {
    phase: 'reviewing',
    locale,
    operation: request.operation,
    input: request.input,
    request,
    plan,
    planDigest: digestFrom(response, plan),
    required,
    granted: [],
    missing,
    highlightedMissing: highlightedMissing.length > 0 ? highlightedMissing : missing,
    dangerConfirmed: false,
    report: response,
  };
}

function failedFromPlanning(state: BrowserPlanningState, response: UiResponse): BrowserFailedState {
  return {
    phase: 'failed',
    locale: state.locale,
    operation: state.operation,
    input: state.input,
    request: state.request,
    error: response,
    report: response,
  };
}

function failedFromApplying(state: BrowserApplyingState, response: UiResponse): BrowserFailedState {
  return {
    phase: 'failed',
    locale: state.locale,
    operation: state.operation,
    input: state.input,
    request: state.request,
    error: response,
    report: response,
  };
}

function hasUsablePlan(response: UiResponse): boolean {
  const metadata = reportMetadata(response);
  return (
    record(metadata.plan) &&
    typeof metadata.planDigest === 'string' &&
    metadata.planDigest.length > 0
  );
}

function cleanPlanRequest(request: UiWriteRequest): UiWriteRequest {
  const { planDigest: _planDigest, ...withoutDigest } = request as UiWriteRequest & {
    readonly planDigest?: string;
  };
  return {
    ...withoutDigest,
    phase: 'plan',
    authorizedDangerousPermissions: [],
  } as UiWriteRequest;
}

function matchesReviewedPlan(state: BrowserApplyingState, response: UiResponse): boolean {
  const plan = planFrom(response);
  return (
    hasUsablePlan(response) &&
    digestFrom(response, plan) === state.planDigest &&
    permissionsEqual(requiredFrom(response), state.required) &&
    jsonEquals(plan, state.plan)
  );
}

function reviewFromApplying(
  state: BrowserApplyingState,
  response: UiResponse,
): BrowserReviewingState {
  const plan = planFrom(response);
  const required = requiredFrom(response);
  const granted = state.granted.filter((item) => hasPermission(required, item));
  const reportedMissing = missingFrom(response).filter((item) => hasPermission(required, item));
  const missing =
    reportedMissing.length > 0
      ? reportedMissing
      : required.filter((item) => !hasPermission(granted, item));
  return {
    phase: 'reviewing',
    locale: state.locale,
    operation: state.operation,
    input: state.input,
    request: cleanPlanRequest(state.request),
    plan,
    planDigest: digestFrom(response, plan),
    required,
    granted,
    missing,
    highlightedMissing: missing,
    // A refused apply always requires a fresh explicit confirmation, even when the
    // returned plan is unchanged.
    dangerConfirmed: false,
    error: response,
    report: response,
  };
}

function staleFrom(
  state: Pick<BrowserPlanningState, 'locale' | 'operation' | 'input' | 'request'>,
  response: UiResponse,
): BrowserStaleState {
  return {
    phase: 'stale',
    locale: state.locale,
    operation: state.operation,
    input: state.input,
    request: cleanPlanRequest(state.request),
    plan: {},
    planDigest: '',
    required: [],
    granted: [],
    missing: [],
    highlightedMissing: [],
    dangerConfirmed: false,
    error: response,
    report: response,
  };
}

function responseStatus(action: BrowserAction): number {
  const httpStatus = 'httpStatus' in action ? action.httpStatus : undefined;
  if (typeof httpStatus === 'number') return httpStatus;
  const status = 'status' in action ? action.status : undefined;
  if (typeof status === 'number') return status;
  return 200;
}

function actionResponse(action: BrowserAction): UiResponse | undefined {
  const value = 'response' in action ? action.response : undefined;
  if (!record(value) || !Array.isArray(value.diagnostics) || !record(value.metadata))
    return undefined;
  return value as unknown as UiResponse;
}

function dangerRequired(state: BrowserReviewFields): boolean {
  return state.required.some((item) => item.kind === 'danger-full-access');
}

function allRequiredGranted(state: BrowserReviewFields): boolean {
  return state.required.every((required) => hasPermission(state.granted, required));
}

export function canApply(state: BrowserState): boolean {
  return (
    state.phase === 'reviewing' &&
    allRequiredGranted(state) &&
    state.highlightedMissing.length === 0 &&
    (!dangerRequired(state) || state.dangerConfirmed)
  );
}

export function missingPermissions(state: BrowserState): readonly UiDangerousPermission[] {
  if (!('required' in state)) return [];
  return state.required.filter((required) => !hasPermission(state.granted, required));
}

function applyingRequest(state: BrowserReviewingState): UiWriteRequest {
  return {
    ...state.request,
    phase: 'apply',
    authorizedDangerousPermissions: [...state.granted],
    planDigest: state.planDigest,
  } as UiWriteRequest;
}

function grant(
  state: BrowserReviewingState,
  candidate: UiDangerousPermission,
  enabled: boolean,
): BrowserReviewingState {
  if (!hasPermission(state.required, candidate)) return state;
  const alreadyGranted = hasPermission(state.granted, candidate);
  if (enabled === alreadyGranted) {
    if (candidate.kind === 'danger-full-access' && !enabled && state.dangerConfirmed)
      return { ...state, dangerConfirmed: false };
    return state;
  }
  const granted = enabled
    ? [...state.granted, candidate]
    : state.granted.filter((item) => !permissionEquals(item, candidate));
  const missing = state.required.filter((item) => !hasPermission(granted, item));
  const highlightedMissing = enabled
    ? state.highlightedMissing.filter((item) => !permissionEquals(item, candidate))
    : hasPermission(state.highlightedMissing, candidate)
      ? state.highlightedMissing
      : [...state.highlightedMissing, candidate];
  return {
    ...state,
    granted,
    missing,
    highlightedMissing,
    dangerConfirmed:
      candidate.kind === 'danger-full-access' && !enabled ? false : state.dangerConfirmed,
  };
}

function normalizeAction(action: BrowserAction): BrowserAction {
  if (
    action.type === 'start-plan' ||
    action.type === 'plan-start' ||
    action.type === 'request-plan'
  )
    return { ...action, type: 'plan' } as BrowserAction;
  if (action.type === 'grant-permission' || action.type === 'authorize')
    return { ...action, type: 'grant' } as BrowserAction;
  if (action.type === 'confirm-danger' || action.type === 'confirm-dangerous')
    return { ...action, type: 'confirm-danger-full-access' } as BrowserAction;
  if (action.type === 'submit-apply' || action.type === 'apply-request')
    return { ...action, type: 'apply' } as BrowserAction;
  return action;
}

export function reduceBrowserState(state: BrowserState, rawAction: BrowserAction): BrowserState {
  const action = normalizeAction(rawAction);

  if (action.type === 'reset') return { phase: 'idle', locale: state.locale };

  if (action.type === 'set-locale') {
    const locale = 'locale' in action ? action.locale : undefined;
    if (locale !== 'zh' && locale !== 'en') return state;
    return { ...state, locale };
  }

  if (action.type === 'plan') {
    if (!['idle', 'reviewing', 'stale', 'done', 'failed'].includes(state.phase)) return state;
    const request =
      'request' in action && action.request !== undefined
        ? (action.request as unknown as UiRequest)
        : undefined;
    const candidate = request === undefined ? undefined : planRequest(request);
    if (candidate === undefined) return state;
    return {
      phase: 'planning',
      locale: state.locale,
      operation: candidate.operation,
      input: candidate.input,
      // A plan is always a fresh review. Never carry caller-supplied grants across the
      // planning boundary, even if a stale or compromised transport puts them in the request.
      request: {
        ...candidate,
        phase: 'plan',
        authorizedDangerousPermissions: [],
      } as UiWriteRequest,
    };
  }

  if (action.type === 'grant' && state.phase === 'reviewing') {
    const candidate = 'permission' in action ? action.permission : undefined;
    const enabled = 'granted' in action ? action.granted !== false : true;
    return permission(candidate) ? grant(state, candidate, enabled) : state;
  }

  if (action.type === 'confirm-danger-full-access' && state.phase === 'reviewing') {
    if (!dangerRequired(state)) return state;
    return {
      ...state,
      dangerConfirmed: typeof action.confirmed === 'boolean' ? action.confirmed : true,
    };
  }

  if (action.type === 'apply' && state.phase === 'reviewing') {
    if (!canApply(state)) return state;
    return { ...state, phase: 'applying', request: applyingRequest(state) };
  }

  if (
    (action.type === 'response' ||
      action.type === 'plan-success' ||
      action.type === 'plan-response' ||
      action.type === 'apply-response') &&
    'response' in action
  ) {
    const responseTypeAllowed =
      (state.phase === 'planning' &&
        (action.type === 'response' ||
          action.type === 'plan-success' ||
          action.type === 'plan-response')) ||
      (state.phase === 'applying' &&
        (action.type === 'response' || action.type === 'apply-response'));
    if (!responseTypeAllowed) return state;
    const status = responseStatus(action);
    const report = actionResponse(action);
    if (report === undefined) return state;
    if (state.phase === 'planning') {
      if (status === 409) {
        return staleFrom(state, report);
      }
      const candidate = reviewFromPlan(state.request, report, state.locale);
      if (status >= 400 || !hasUsablePlan(report)) return failedFromPlanning(state, report);
      return candidate;
    }
    if (state.phase === 'applying') {
      if (status === 403)
        return matchesReviewedPlan(state, report)
          ? reviewFromApplying(state, report)
          : staleFrom(state, report);
      if (status === 409) return staleFrom(state, report);
      if (status >= 200 && status < 300)
        return {
          ...state,
          phase: 'done',
          report,
        };
      return failedFromApplying(state, report);
    }
  }

  return state;
}

export const reduce = reduceBrowserState;
