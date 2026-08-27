import type { UiDangerousPermission, UiResponse, UiWriteRequest } from 'dshpack';
import { describe, expect, it } from 'vitest';
import {
  type BrowserApplyingState,
  type BrowserReviewingState,
  canApply,
  createBrowserState,
  createInitialState,
  missingPermissions,
  permissionEquals,
  reduce,
  reduceBrowserState,
} from '../src/state.js';

const buildPermission = {
  kind: 'allow-build',
  subject: 'pack-a',
} as const satisfies UiDangerousPermission;

const fullAccessPermission = {
  kind: 'danger-full-access',
  subject: 'pack-a',
} as const satisfies UiDangerousPermission;

const request = {
  operation: 'install',
  phase: 'plan',
  input: { source: 'https://example.invalid/<img src=x onerror=alert(1)>' },
  authorizedDangerousPermissions: [],
} as const satisfies UiWriteRequest;

function response(
  required: readonly UiDangerousPermission[] = [],
  options: {
    readonly digest?: string;
    readonly missing?: readonly UiDangerousPermission[];
    readonly exitCode?: UiResponse['exitCode'];
  } = {},
): UiResponse {
  return {
    diagnostics: [],
    exitCode: options.exitCode ?? (0 as UiResponse['exitCode']),
    metadata: {
      plan: { operation: 'install', writes: [] },
      planDigest: options.digest ?? 'sha256-plan-a',
      requiredDangerousPermissions: required,
      ...(options.missing === undefined ? {} : { missingDangerousPermissions: options.missing }),
    },
  };
}

function toReview(
  required: readonly UiDangerousPermission[] = [],
  report = response(required),
): BrowserReviewingState {
  const planning = reduceBrowserState(createBrowserState(), { type: 'plan', request });
  const reviewed = reduceBrowserState(planning, { type: 'plan-success', response: report });
  expect(reviewed.phase).toBe('reviewing');
  return reviewed as BrowserReviewingState;
}

function asReviewing(state: ReturnType<typeof reduceBrowserState>): BrowserReviewingState {
  expect(state.phase).toBe('reviewing');
  if (state.phase !== 'reviewing') throw new Error('expected reviewing state');
  return state;
}

describe('browser state model', () => {
  it('follows idle -> planning -> reviewing with an empty grant set', () => {
    const idle = createInitialState();
    expect(idle).toMatchObject({ phase: 'idle', locale: 'zh' });

    const planning = reduce(idle, { type: 'plan', request });
    expect(planning).toMatchObject({ phase: 'planning', operation: 'install' });

    const reviewing = reduce(planning, {
      type: 'plan-success',
      response: response([buildPermission]),
    });
    expect(reviewing).toMatchObject({
      phase: 'reviewing',
      planDigest: 'sha256-plan-a',
      required: [buildPermission],
      granted: [],
      missing: [buildPermission],
      dangerConfirmed: false,
    });
  });

  it('changes locale through an ordinary state action without changing lifecycle phase', () => {
    const idle = createBrowserState();
    const english = reduceBrowserState(idle, { type: 'set-locale', locale: 'en' });

    expect(english).toMatchObject({ phase: 'idle', locale: 'en' });
    expect(reduceBrowserState(english, { type: 'set-locale', locale: 'zh' })).toMatchObject({
      phase: 'idle',
      locale: 'zh',
    });
    expect(reduceBrowserState(english, { type: 'set-locale', locale: 'other' } as never)).toBe(
      english,
    );
  });

  it('starts every new plan with all dangerous grants switched off', () => {
    const preauthorized = {
      ...request,
      authorizedDangerousPermissions: [buildPermission],
    } as const satisfies UiWriteRequest;
    const planning = reduceBrowserState(createBrowserState(), {
      type: 'plan',
      request: preauthorized,
    });
    expect(planning.phase).toBe('planning');
    if (planning.phase !== 'planning') throw new Error('expected planning state');
    expect(planning.request.authorizedDangerousPermissions).toEqual([]);

    const review = reduceBrowserState(planning, {
      type: 'plan-success',
      response: response([buildPermission]),
    });
    expect(review).toMatchObject({ phase: 'reviewing', granted: [], dangerConfirmed: false });
  });

  it('requires exact itemized grants and an independent danger-full-access confirmation', () => {
    const reviewing = toReview([buildPermission, fullAccessPermission]);
    const unrelated = {
      kind: 'allow-build',
      subject: 'pack-a-core',
    } as const satisfies UiDangerousPermission;

    const ignored = asReviewing(reduce(reviewing, { type: 'grant', permission: unrelated }));
    expect(ignored.granted).toEqual([]);

    const oneGrant = asReviewing(reduce(ignored, { type: 'grant', permission: buildPermission }));
    expect(oneGrant.granted).toEqual([buildPermission]);
    expect(canApply(oneGrant)).toBe(false);

    const twoGrants = asReviewing(
      reduce(oneGrant, { type: 'grant', permission: fullAccessPermission }),
    );
    expect(twoGrants.granted).toEqual([buildPermission, fullAccessPermission]);
    expect(twoGrants.dangerConfirmed).toBe(false);
    expect(canApply(twoGrants)).toBe(false);

    const confirmed = asReviewing(reduce(twoGrants, { type: 'confirm-danger-full-access' }));
    expect(confirmed.dangerConfirmed).toBe(true);
    expect(canApply(confirmed)).toBe(true);

    const applying = reduce(confirmed, { type: 'apply' });
    expect(applying.phase).toBe('applying');
    if (applying.phase !== 'applying') throw new Error('expected applying state');
    expect(applying.request.phase).toBe('apply');
    expect(applying.request.authorizedDangerousPermissions).toEqual([
      buildPermission,
      fullAccessPermission,
    ]);
  });

  it('supports checking and unchecking an individual permission grant', () => {
    const initial = toReview([buildPermission]);
    const checked = asReviewing(
      reduceBrowserState(initial, { type: 'grant', permission: buildPermission, granted: true }),
    );
    expect(checked.granted).toEqual([buildPermission]);
    expect(canApply(checked)).toBe(true);

    const unchecked = asReviewing(
      reduceBrowserState(checked, { type: 'grant', permission: buildPermission, granted: false }),
    );
    expect(unchecked.granted).toEqual([]);
    expect(unchecked.missing).toEqual([buildPermission]);
    expect(canApply(unchecked)).toBe(false);
  });

  it('requires a new danger confirmation after danger-full-access is revoked and regranted', () => {
    const review = toReview([buildPermission, fullAccessPermission]);
    const bothGranted = asReviewing(
      reduce(asReviewing(reduce(review, { type: 'grant', permission: buildPermission })), {
        type: 'grant',
        permission: fullAccessPermission,
      }),
    );
    const confirmed = asReviewing(reduce(bothGranted, { type: 'confirm-danger-full-access' }));
    expect(canApply(confirmed)).toBe(true);

    const revoked = asReviewing(
      reduce(confirmed, { type: 'grant', permission: fullAccessPermission, granted: false }),
    );
    expect(revoked.dangerConfirmed).toBe(false);
    const regranted = asReviewing(
      reduce(revoked, { type: 'grant', permission: fullAccessPermission, granted: true }),
    );
    expect(regranted.dangerConfirmed).toBe(false);
    expect(canApply(regranted)).toBe(false);
  });

  it('compares permission fields without delimiter collisions', () => {
    const joined = {
      kind: 'version-mismatch',
      subject: 'dsh',
      tested: ['a\u0001b'],
    } as const satisfies UiDangerousPermission;
    const split = {
      kind: 'version-mismatch',
      subject: 'dsh',
      tested: ['a', 'b'],
    } as const satisfies UiDangerousPermission;
    expect(permissionEquals(joined, split)).toBe(false);
  });

  it('ignores a bulk-consent action instead of widening individual grants', () => {
    const review = toReview([buildPermission, fullAccessPermission]);
    const attempted = reduceBrowserState(review, {
      type: 'grant-all',
      permissions: [buildPermission, fullAccessPermission],
    });
    expect(attempted).toBe(review);
    expect(attempted).toMatchObject({ granted: [], dangerConfirmed: false });
  });

  it('returns to reviewing on 403, highlighting only server-reported missing grants without replay', () => {
    const reviewing = toReview([buildPermission]);
    const applying = reduce(reduce(reviewing, { type: 'grant', permission: buildPermission }), {
      type: 'apply',
    });
    expect(applying.phase).toBe('applying');

    const missing = [buildPermission] as const;
    const refused = reduce(applying, {
      type: 'response',
      httpStatus: 403,
      response: response([buildPermission], { missing }),
    });
    expect(refused).toMatchObject({
      phase: 'reviewing',
      granted: [buildPermission],
      missing: [buildPermission],
      highlightedMissing: [buildPermission],
    });
    if (refused.phase !== 'reviewing') throw new Error('expected reviewing state');
    expect(refused.planDigest).toBe('sha256-plan-a');
    expect(refused.required).toEqual([buildPermission]);
    expect(refused.request).toMatchObject({ phase: 'plan', authorizedDangerousPermissions: [] });
    expect(refused.request).not.toHaveProperty('planDigest');
    expect(refused).not.toHaveProperty('replay');
    expect(canApply(refused)).toBe(false);
    expect(reduce(refused, { type: 'apply' })).toBe(refused);
  });

  it('never adds a grant from a same-plan 403 response', () => {
    const review = toReview([buildPermission, fullAccessPermission]);
    const applying: BrowserApplyingState = {
      ...review,
      phase: 'applying',
      granted: [buildPermission],
      missing: [fullAccessPermission],
      highlightedMissing: [],
      request: {
        ...request,
        phase: 'apply',
        authorizedDangerousPermissions: [buildPermission],
        planDigest: review.planDigest,
      } as UiWriteRequest,
    };
    const refused = reduce(applying, {
      type: 'response',
      httpStatus: 403,
      response: response([buildPermission, fullAccessPermission], {
        missing: [fullAccessPermission],
      }),
    });

    expect(refused).toMatchObject({
      phase: 'reviewing',
      granted: [buildPermission],
      missing: [fullAccessPermission],
      highlightedMissing: [fullAccessPermission],
      dangerConfirmed: false,
    });
    expect(canApply(refused)).toBe(false);
  });

  it('stales when a 403 returns a changed digest or required permission set', () => {
    const reviewing = toReview([buildPermission]);
    const applying = reduce(
      asReviewing(reduce(reviewing, { type: 'grant', permission: buildPermission })),
      { type: 'apply' },
    );
    expect(applying.phase).toBe('applying');

    const refused = reduce(applying, {
      type: 'response',
      httpStatus: 403,
      response: response([buildPermission, fullAccessPermission], {
        digest: 'sha256-plan-expanded',
        missing: [fullAccessPermission],
      }),
    });
    expect(refused).toMatchObject({
      phase: 'stale',
      planDigest: '',
      plan: {},
      required: [],
      granted: [],
      missing: [],
      highlightedMissing: [],
      dangerConfirmed: false,
    });
    if (refused.phase !== 'stale') throw new Error('expected stale state');
    expect(refused.request).toMatchObject({ phase: 'plan', authorizedDangerousPermissions: [] });
    expect(refused.request).not.toHaveProperty('planDigest');
    expect(canApply(refused)).toBe(false);
  });

  it('moves 409 responses to stale and clears grants until a fresh plan succeeds', () => {
    const reviewing = toReview([buildPermission, fullAccessPermission]);
    const granted = asReviewing(
      reduce(asReviewing(reduce(reviewing, { type: 'grant', permission: buildPermission })), {
        type: 'grant',
        permission: fullAccessPermission,
      }),
    );
    const applying = reduce(reduce(granted, { type: 'confirm-danger-full-access' }), {
      type: 'apply',
    });
    const stale = reduce(applying, {
      type: 'response',
      httpStatus: 409,
      response: response([buildPermission, fullAccessPermission], { digest: 'sha256-plan-b' }),
    });
    expect(stale).toMatchObject({
      phase: 'stale',
      granted: [],
      required: [],
      dangerConfirmed: false,
      planDigest: '',
    });
    if (stale.phase !== 'stale') throw new Error('expected stale state');
    expect(stale.request).toMatchObject({ phase: 'plan', authorizedDangerousPermissions: [] });
    expect(stale.request).not.toHaveProperty('planDigest');
    expect(canApply(stale)).toBe(false);

    const replanning = reduce(stale, { type: 'plan', request });
    expect(replanning.phase).toBe('planning');
    const fresh = reduce(replanning, {
      type: 'plan-success',
      response: response([buildPermission, fullAccessPermission], { digest: 'sha256-plan-c' }),
    });
    expect(fresh).toMatchObject({
      phase: 'reviewing',
      planDigest: 'sha256-plan-c',
      granted: [],
    });
  });

  it('clears prior grants whenever a plan succeeds again', () => {
    const reviewing = toReview([buildPermission]);
    const granted = reduce(reviewing, { type: 'grant', permission: buildPermission });
    const replanning = reduce(granted, { type: 'plan', request });
    const fresh = reduce(replanning, {
      type: 'plan-success',
      response: response([buildPermission], { digest: 'sha256-plan-new' }),
    });
    expect(fresh).toMatchObject({ phase: 'reviewing', granted: [], dangerConfirmed: false });
  });

  it('rejects mismatched response events and overlapping plan requests', () => {
    const planning = reduceBrowserState(createBrowserState(), { type: 'plan', request });
    expect(reduceBrowserState(planning, { type: 'plan', request })).toBe(planning);
    expect(
      reduceBrowserState(planning, {
        type: 'apply-response',
        response: response([buildPermission]),
      }),
    ).toBe(planning);

    const review = asReviewing(
      reduceBrowserState(planning, { type: 'plan-success', response: response([buildPermission]) }),
    );
    const applying = reduce(
      asReviewing(reduce(review, { type: 'grant', permission: buildPermission })),
      { type: 'apply' },
    );
    expect(applying.phase).toBe('applying');
    expect(reduce(applying, { type: 'plan-success', response: response([]) })).toBe(applying);
    expect(reduce(applying, { type: 'plan', request })).toBe(applying);
  });

  it('moves a failed plan into failed and allows a new plan attempt', () => {
    const planning = reduceBrowserState(createBrowserState(), { type: 'plan', request });
    const failedReport = response([], { exitCode: 20 as UiResponse['exitCode'] });
    const failed = reduceBrowserState(planning, {
      type: 'plan-success',
      httpStatus: 500,
      response: failedReport,
    });
    expect(failed).toMatchObject({ phase: 'failed', error: failedReport });

    const retry = reduceBrowserState(failed, { type: 'plan', request });
    expect(retry.phase).toBe('planning');
  });

  it('reaches done only after an apply response', () => {
    const reviewing = toReview([]);
    const applying = reduce(reviewing, { type: 'apply' });
    expect(applying.phase).toBe('applying');
    const done = reduce(applying, { type: 'response', httpStatus: 200, response: response([]) });
    expect(done).toMatchObject({ phase: 'done', report: response([]) });
  });

  it('moves a non-2xx apply response into failed instead of claiming done', () => {
    const reviewed = toReview([buildPermission]);
    const granted = asReviewing(reduce(reviewed, { type: 'grant', permission: buildPermission }));
    const applying = reduce(granted, { type: 'apply' });
    expect(applying.phase).toBe('applying');
    const failedReport = response([], { exitCode: 20 as UiResponse['exitCode'] });
    const failed = reduce(applying, {
      type: 'response',
      httpStatus: 500,
      response: failedReport,
    });
    expect(failed).toMatchObject({ phase: 'failed', error: failedReport });
    expect(failed).not.toHaveProperty('granted');
  });

  it('filters malformed permissions and preserves only exact structured permission variants', () => {
    const newPlugin = {
      kind: 'new-plugin',
      subject: 'plugins/alpha',
      identity: 'alpha@1.0.0',
    } as const satisfies UiDangerousPermission;
    const versionMismatch = {
      kind: 'version-mismatch',
      subject: 'dsh',
      tested: ['1.0.0', '2.0.0'],
    } as const satisfies UiDangerousPermission;
    const malformed = {
      diagnostics: [],
      exitCode: 0,
      metadata: {
        plan: { operation: 'install' },
        planDigest: 'sha256-structured-permissions',
        requiredDangerousPermissions: [
          null,
          { kind: 'new-plugin', subject: 'plugins/invalid' },
          { kind: 'version-mismatch', subject: 'dsh', tested: ['1.0.0', 2] },
          newPlugin,
          newPlugin,
          versionMismatch,
        ],
      },
    } as unknown as UiResponse;

    const planning = reduceBrowserState(createBrowserState(), { type: 'plan', request });
    const reviewing = reduceBrowserState(planning, { type: 'plan-success', response: malformed });
    expect(reviewing).toMatchObject({ phase: 'reviewing', required: [newPlugin, versionMismatch] });
    expect(missingPermissions(reviewing)).toEqual([newPlugin, versionMismatch]);
    expect(permissionEquals(newPlugin, { ...newPlugin, identity: 'alpha@2.0.0' })).toBe(false);
    expect(permissionEquals(versionMismatch, { ...versionMismatch, tested: ['1.0.0'] })).toBe(
      false,
    );
    expect(
      permissionEquals(versionMismatch, { ...versionMismatch, tested: ['2.0.0', '1.0.0'] }),
    ).toBe(false);
  });

  it('fails closed for malformed requests and responses while accepting legacy action aliases', () => {
    const idle = createBrowserState();
    const notAWriteRequest = { operation: 'list', input: {}, phase: 'plan' };
    expect(reduceBrowserState(idle, { type: 'plan' })).toBe(idle);
    expect(reduceBrowserState(idle, { type: 'plan', request: notAWriteRequest as never })).toBe(
      idle,
    );

    const planning = reduceBrowserState(idle, { type: 'start-plan', request });
    expect(planning.phase).toBe('planning');
    expect(
      reduceBrowserState(planning, {
        type: 'plan-success',
        response: { diagnostics: 'not-an-array', exitCode: 0, metadata: {} } as never,
      }),
    ).toBe(planning);

    const stale = reduceBrowserState(planning, {
      type: 'plan-response',
      status: 409,
      response: response([]),
    });
    expect(stale).toMatchObject({ phase: 'stale', granted: [], dangerConfirmed: false });

    const review = toReview([fullAccessPermission]);
    expect(reduceBrowserState(review, { type: 'grant-permission' })).toBe(review);
    const confirmed = reduceBrowserState(review, {
      type: 'confirm-danger',
      confirmed: false,
    });
    expect(confirmed).toMatchObject({ phase: 'reviewing', dangerConfirmed: false });
    expect(reduceBrowserState(confirmed, { type: 'submit-apply' })).toBe(confirmed);
    expect(missingPermissions(createBrowserState())).toEqual([]);
  });
});
