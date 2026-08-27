import { afterEach, describe, expect, it, vi } from 'vitest';

import { startBrowserUi } from '../src/main.js';
import {
  descendants,
  elementWithText,
  FakeDocument,
  type FakeElement,
  FakeInputElement,
  FakeWindow,
  visibleText,
} from './fake-dom.js';

type JsonReport = {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly reject?: boolean;
  readonly jsonReject?: boolean;
};

const statusBody = {
  diagnostics: [],
  exitCode: 0,
  metadata: {
    profiles: [
      {
        profile: 'alpha',
        status: 'tracked',
        pack: { name: 'pack-alpha', version: '1.0.0' },
        packDetails: {
          manifest: { source: 'from-list-response' },
          lock: { commitment: 'list-lock' },
        },
        drift: 1,
        sharedAssets: 0,
        update: 'none',
      },
    ],
  },
};

const untrackedStatusBody = {
  diagnostics: [],
  exitCode: 0,
  metadata: {
    profiles: [{ profile: 'orphan', status: 'untracked' }],
  },
};

const writePlanWithPackBody = {
  diagnostics: [],
  exitCode: 0,
  metadata: {
    plan: { operation: 'update' },
    planDigest: 'sha256-plan',
    requiredDangerousPermissions: [],
    manifest: { source: 'from-write-plan-response' },
  },
};

const doctorBody = {
  diagnostics: [],
  exitCode: 0,
  metadata: { sideEffects: [] },
};

const planBody = {
  diagnostics: [],
  exitCode: 0,
  metadata: {
    plan: { operation: 'update' },
    planDigest: 'sha256-plan',
    requiredDangerousPermissions: [],
  },
};

const buildPermission = { kind: 'allow-build', subject: 'alpha' } as const;
const fullAccessPermission = { kind: 'danger-full-access', subject: 'alpha' } as const;

function planWith(
  required: readonly Record<string, unknown>[] = [],
  missing: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    diagnostics: [],
    exitCode: 0,
    metadata: {
      plan: { operation: 'update' },
      planDigest: 'sha256-plan',
      requiredDangerousPermissions: required,
      missingDangerousPermissions: missing,
    },
  };
}

function inputs(root: FakeElement): readonly FakeInputElement[] {
  return descendants(root).filter(
    (element): element is FakeInputElement => element instanceof FakeInputElement,
  );
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function requestBodies(
  calls: readonly { readonly input: unknown; readonly init?: RequestInit }[],
): readonly Record<string, unknown>[] {
  return calls
    .map((call) => (typeof call.init?.body === 'string' ? JSON.parse(call.init.body) : undefined))
    .filter((body): body is Record<string, unknown> => body !== undefined);
}

function installBrowserFakes(
  queue: readonly JsonReport[],
  href = 'http://127.0.0.1/?token=memory-token#overview',
): {
  readonly document: FakeDocument;
  readonly window: FakeWindow;
  readonly calls: Array<{ readonly input: unknown; readonly init?: RequestInit }>;
} {
  const document = new FakeDocument();
  const window = new FakeWindow(href);
  const calls: Array<{ readonly input: unknown; readonly init?: RequestInit }> = [];
  const pending = [...queue];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push(init === undefined ? { input } : { input, init });
    const next: JsonReport = pending.shift() ?? { status: 200, body: planBody };
    if (next.reject === true) throw new Error('offline');
    return {
      status: next.status,
      json: async () => {
        if (next.jsonReject === true) throw new Error('invalid json');
        return next.body;
      },
    } as Response;
  });
  vi.stubGlobal('window', window);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('HTMLInputElement', FakeInputElement);
  return { document, window, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser main shell behavior', () => {
  it('materializes only the active hash view and switches it on hashchange', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: doctorBody },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    const activeSections = () =>
      descendants(root).filter(
        (element) =>
          element.tagName === 'section' &&
          element.children.some((child) => child.tagName === 'main'),
      );
    expect(activeSections()).toHaveLength(1);
    expect(activeSections()[0]?.children[0]?.tagName).toBe('main');
    fakes.window.location.hash = '#doctor';
    expect(activeSections()).toHaveLength(1);
    expect(visibleText(activeSections()[0] as FakeElement)).toContain('doctor');
  });

  it('renders each hash-selected screen into the one active mount', async () => {
    const fakes = installBrowserFakes([{ status: 200, body: statusBody }]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    for (const [hash, heading] of [
      ['#profile-diff', 'profile diff'],
      ['#pack', 'pack'],
      ['#write-review', 'write review'],
      ['#unknown', 'profiles'],
    ] as const) {
      fakes.window.location.hash = hash;
      const views = descendants(root).filter(
        (element) => element !== root && element.tagName === 'main',
      );
      expect(views).toHaveLength(1);
      expect(visibleText(views[0] as FakeElement)).toContain(heading);
    }
  });

  it('loads profile, pack, and write-review controls through their active view handlers', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: { diagnostics: [], exitCode: 0, metadata: {} } },
      { status: 200, body: planWith() },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'View profile')?.fire('click');
    await settle();
    expect(fakes.window.location.hash).toBe('#profile-diff');
    fakes.window.location.hash = '#write-review';
    const source = descendants(root).find(
      (element) => element.tagName === 'input' && element.type === 'text',
    );
    if (source !== undefined) source.value = '';
    elementWithText(root, 'Plan write operation')?.fire('click');
    expect(visibleText(root)).toContain('Enter a source or profile before planning.');
    elementWithText(root, 'Reset review')?.fire('click');
    fakes.window.location.hash = '#pack';
    expect(elementWithText(root, 'View pack details')).toBeUndefined();
    expect(fakes.window.location.hash).toBe('#pack');
  });

  it('requests list with an empty input and views row packDetails without replacing it from a write plan', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: writePlanWithPackBody },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    expect(requestBodies(fakes.calls)[0]).toEqual({ operation: 'list', input: {} });
    elementWithText(root, 'View pack')?.fire('click');
    await settle();
    expect(fakes.window.location.hash).toBe('#pack');
    expect(visibleText(root)).toContain('from-list-response');

    fakes.window.location.hash = '#overview';
    elementWithText(root, 'Update profile')?.fire('click');
    await settle();
    expect(fakes.window.location.hash).toBe('#write-review');

    fakes.window.location.hash = '#pack';
    expect(visibleText(root)).toContain('from-list-response');
    expect(visibleText(root)).not.toContain('from-write-plan-response');
  });

  it('fails closed when a profile control does not identify a tracked profile', async () => {
    const fakes = installBrowserFakes([{ status: 200, body: untrackedStatusBody }]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'View diff')?.fire('click');
    expect(visibleText(root)).toContain('Select a profile before loading its diff.');
  });

  it('revalidates a row as tracked at click time before starting a write plan', async () => {
    const mutableProfile = {
      profile: 'alpha',
      status: 'tracked',
      pack: { name: 'pack-alpha', version: '1.0.0' },
      drift: 0,
      sharedAssets: 0,
      update: 'none',
    };
    const fakes = installBrowserFakes([
      {
        status: 200,
        body: { diagnostics: [], exitCode: 0, metadata: { profiles: [mutableProfile] } },
      },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    mutableProfile.status = 'untracked';
    const update = descendants(root).find(
      (element) => element.tagName === 'button' && element.textContent === 'Update profile',
    );
    expect(update).toBeDefined();
    update?.fire('click');

    expect(visibleText(root)).toContain('Select a tracked profile before planning.');
    expect(requestBodies(fakes.calls)).toEqual([{ operation: 'list', input: {} }]);
  });

  it('fails closed when a non-input event targets an ordinary permission grant', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: planWith([buildPermission], [buildPermission]) },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'Update profile')?.fire('click');
    await settle();
    vi.stubGlobal('HTMLInputElement', class NotAnInput {});
    inputs(root)
      .filter((candidate) => candidate.type === 'checkbox')
      .at(0)
      ?.fire('change');

    const ordinaryGrant = inputs(root).find((candidate) => candidate.type === 'checkbox');
    expect(ordinaryGrant?.checked).toBe(false);
    expect(elementWithText(root, 'Apply reviewed plan')?.disabled).toBe(true);
    expect(
      requestBodies(fakes.calls)
        .filter((body) => typeof body.phase === 'string')
        .map((body) => body.phase),
    ).toEqual(['plan']);
  });

  it('uses overview rows to plan update, uninstall, and restore against /api', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: doctorBody },
      { status: 200, body: planBody },
      { status: 200, body: planBody },
      { status: 200, body: planBody },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    for (const action of ['Update profile', 'Uninstall profile', 'Restore profile']) {
      fakes.window.location.hash = '#overview';
      await settle();
      const button = elementWithText(root, action);
      expect(button, action).toBeDefined();
      button?.fire('click');
      await settle();
      expect(fakes.window.location.hash).toBe('#write-review');
    }

    const bodies = requestBodies(fakes.calls);
    expect(bodies.slice(-3).map((body) => body.operation)).toEqual([
      'update',
      'uninstall',
      'restore',
    ]);
    for (const body of bodies.slice(-3)) {
      expect(body.phase).toBe('plan');
      expect(body.authorizedDangerousPermissions).toEqual([]);
    }
    for (const call of fakes.calls) {
      expect(call.input).toBe('/api');
      expect(call.init?.credentials).toBe('omit');
      expect(call.init?.headers).toMatchObject({ Authorization: 'Bearer memory-token' });
    }
  });

  it('routes overview read controls and the top plan form through fixed wire requests', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: { diagnostics: [], exitCode: 0, metadata: {} } },
      { status: 200, body: doctorBody },
      { status: 200, body: planWith() },
      { status: 200, body: planWith() },
      { status: 200, body: planWith() },
      { status: 200, body: planWith() },
      { status: 200, body: planWith() },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'View diff')?.fire('click');
    await settle();
    fakes.window.location.hash = '#overview';
    elementWithText(root, 'View profile')?.fire('click');
    await settle();
    fakes.window.location.hash = '#overview';
    elementWithText(root, 'Run doctor')?.fire('click');
    await settle();
    expect(requestBodies(fakes.calls).filter((body) => body.operation === 'doctor')).toHaveLength(
      1,
    );

    const select = descendants(root).find((element) => element.tagName === 'select');
    const source = descendants(root).find(
      (element) => element.tagName === 'input' && element.type === 'text',
    );
    const plan = elementWithText(root, 'Plan');
    expect(select).toBeDefined();
    expect(source).toBeDefined();
    expect(plan).toBeDefined();
    for (const [operation, value] of [
      ['install', 'https://example.invalid/pack.tgz'],
      ['uninstall', 'alpha'],
      ['update', 'alpha'],
      ['restore', 'alpha'],
      ['gc', ''],
    ] as const) {
      if (select !== undefined && source !== undefined) {
        select.value = operation;
        source.value = value;
      }
      plan?.fire('click');
      await settle();
    }

    const writes = requestBodies(fakes.calls).filter((body) => body.phase === 'plan');
    expect(writes.map((body) => body.operation)).toEqual([
      'install',
      'uninstall',
      'update',
      'restore',
      'gc',
    ]);
    expect(writes[0]?.input).toMatchObject({ source: 'https://example.invalid/pack.tgz' });
    expect(writes[4]?.input).toEqual({});
  });

  it('declines malformed form operations and reports empty diff/profile actions locally', async () => {
    const fakes = installBrowserFakes([{ status: 200, body: statusBody }]);
    const root = fakes.document.createElement('main');
    const controller = startBrowserUi(root as unknown as HTMLElement);
    await settle();

    const select = descendants(root).find((element) => element.tagName === 'select');
    const source = descendants(root).find(
      (element) => element.tagName === 'input' && element.type === 'text',
    );
    if (select !== undefined && source !== undefined) {
      select.value = 'not-an-operation';
      source.value = '';
    }
    elementWithText(root, 'Plan')?.fire('click');
    expect(visibleText(root)).toContain('Enter a source or profile before planning.');

    await controller.refreshDiff();
    expect(visibleText(root)).toContain('Enter a profile before loading its diff.');
  });

  it('does not turn an unknown review-panel operation into an API request', async () => {
    const fakes = installBrowserFakes([{ status: 200, body: statusBody }]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    fakes.window.location.hash = '#write-review';
    const select = descendants(root).find((element) => element.tagName === 'select');
    if (select === undefined) throw new Error('expected operation select');
    select.value = 'unknown-operation';
    const plan = elementWithText(root, 'Plan write operation');
    expect(plan).toBeDefined();
    plan?.fire('click');

    expect(visibleText(root)).toContain('Enter a source or profile before planning.');
    expect(requestBodies(fakes.calls)).toEqual([{ operation: 'list', input: {} }]);
  });

  it('keeps apply disabled until exact grants and danger confirmation, then renders a 403 review', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      {
        status: 200,
        body: planWith(
          [buildPermission, fullAccessPermission],
          [buildPermission, fullAccessPermission],
        ),
      },
      {
        status: 403,
        body: planWith([buildPermission, fullAccessPermission], [fullAccessPermission]),
      },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    const update = elementWithText(root, 'Update profile');
    update?.fire('click');
    await settle();
    expect(elementWithText(root, 'Apply reviewed plan')?.disabled).toBe(true);
    elementWithText(root, 'Apply reviewed plan')?.fire('click');

    for (const input of inputs(root).filter((candidate) => candidate.type === 'checkbox')) {
      expect(input).toBeDefined();
      input.checked = true;
      input.fire('change');
    }
    const apply = elementWithText(root, 'Apply reviewed plan');
    expect(apply?.disabled).toBe(false);
    apply?.fire('click');
    await settle();

    expect(visibleText(root)).toContain('missing permissions');
    expect(visibleText(root)).toContain('danger-full-access: alpha');
    expect(
      requestBodies(fakes.calls)
        .filter((body) => typeof body.phase === 'string')
        .map((body) => body.phase),
    ).toEqual(['plan', 'apply']);
  });

  it('clears stale review grants on 409 and retries the fresh plan', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: planWith() },
      { status: 409, body: planWith() },
      { status: 200, body: planWith() },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'Update profile')?.fire('click');
    await settle();
    elementWithText(root, 'Apply reviewed plan')?.fire('click');
    await settle();
    expect(visibleText(root)).toContain('plan is stale');
    elementWithText(root, 'Plan again')?.fire('click');
    await settle();

    const bodies = requestBodies(fakes.calls).filter((body) => typeof body.phase === 'string');
    expect(bodies.map((body) => body.phase)).toEqual(['plan', 'apply', 'plan']);
    expect(bodies[2]?.authorizedDangerousPermissions).toEqual([]);
  });

  it('fails closed for an absent token and tolerates an unavailable same-origin transport', async () => {
    const noToken = installBrowserFakes([], 'http://127.0.0.1/#overview');
    const noTokenRoot = noToken.document.createElement('main');
    const noTokenController = startBrowserUi(noTokenRoot as unknown as HTMLElement);
    await noTokenController.refreshOverview();
    expect(noToken.calls).toEqual([]);

    vi.unstubAllGlobals();
    const offline = installBrowserFakes([{ status: 0, body: {}, reject: true }]);
    const offlineRoot = offline.document.createElement('main');
    const offlineController = startBrowserUi(offlineRoot as unknown as HTMLElement);
    await offlineController.refreshOverview();
    expect(offline.calls).toHaveLength(2);
  });

  it('treats invalid and undecodable same-origin responses as local failure reports', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: {} },
      { status: 200, body: {}, jsonReject: true },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    fakes.window.location.hash = '#doctor';
    await settle();

    expect(visibleText(root)).toContain('E_UI_RESPONSE');
    expect(visibleText(root)).toContain('The UI server returned an invalid response.');
    expect(fakes.calls).toHaveLength(2);
  });

  it('keeps non-input review events conservative and re-renders an already selected navigation screen', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: planWith([fullAccessPermission], [fullAccessPermission]) },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    const activeMount = descendants(root).find(
      (element) =>
        element.tagName === 'section' && element.children.some((child) => child.tagName === 'main'),
    );
    if (activeMount === undefined) throw new Error('expected active mount');
    activeMount.textContent = 'tampered active view';
    expect(activeMount.textContent).toContain('tampered active view');
    elementWithText(root, 'overview')?.fire('click');
    expect(activeMount.textContent).toContain('profiles');
    expect(activeMount.textContent).not.toContain('tampered active view');
    elementWithText(root, 'Update profile')?.fire('click');
    await settle();

    vi.stubGlobal('HTMLInputElement', class NotAnInput {});
    for (const input of inputs(root).filter((candidate) => candidate.type === 'checkbox'))
      input.fire('change');
    expect(elementWithText(root, 'Apply reviewed plan')?.disabled).toBe(true);
    expect(fakes.window.location.hash).toBe('#write-review');
  });

  it('auto-starts with body after readiness and waits for DOMContentLoaded while loading', async () => {
    const ready = installBrowserFakes([{ status: 200, body: statusBody }]);
    vi.stubGlobal('document', ready.document);
    vi.resetModules();
    await import('../src/main.js');
    await settle();
    expect(elementWithText(ready.document.body, 'Pack management')).toBeDefined();

    vi.unstubAllGlobals();
    const loading = installBrowserFakes([{ status: 200, body: statusBody }]);
    loading.document.readyState = 'loading';
    vi.stubGlobal('document', loading.document);
    vi.resetModules();
    await import('../src/main.js');
    expect(elementWithText(loading.document.body, 'Pack management')).toBeUndefined();
    loading.document.fire('DOMContentLoaded');
    await settle();
    expect(elementWithText(loading.document.body, 'Pack management')).toBeDefined();
  });
});
