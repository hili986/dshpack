import { afterEach, describe, expect, it, vi } from 'vitest';

import { startBrowserUi } from '../src/main.js';
import {
  descendants,
  elementWithText,
  FakeDocument,
  FakeElement,
  FakeInputElement,
  FakeTextAreaElement,
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

function textareas(root: FakeElement): readonly FakeTextAreaElement[] {
  return descendants(root).filter(
    (element): element is FakeTextAreaElement => element instanceof FakeTextAreaElement,
  );
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function deferredResponse(): {
  readonly promise: Promise<Response>;
  readonly resolve: (response: Response) => void;
} {
  let resolve: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: (response) => resolve(response) };
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
  vi.stubGlobal('HTMLSelectElement', FakeElement);
  vi.stubGlobal('HTMLTextAreaElement', FakeTextAreaElement);
  return { document, window, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser main shell behavior', () => {
  it('renders compose validation and preview diagnostics inside the compose view', async () => {
    const skipped = 'Skipped non-regular archive entry: .claude/skills/link.';
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      {
        status: 200,
        body: {
          diagnostics: [
            {
              code: 'E_ARCHIVE_ENTRY_SKIPPED',
              severity: 'warning',
              message: skipped,
              hint: 'The entry was not deployed or followed.',
            },
          ],
          exitCode: 0,
          metadata: { phase: 'preview', sourceSkills: [], selected: [], conflicts: [] },
        },
      },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    fakes.window.location.hash = '#compose';
    const composeInputs = inputs(root).filter((input) => input.type === 'text');
    const profile = composeInputs[1];
    const source = composeInputs[2];
    if (profile === undefined || source === undefined) throw new Error('expected compose inputs');
    expect(profile.placeholder).toBe('my-research-kit');
    profile.value = '中文名称';
    profile.fire('input');
    elementWithText(root, '预览组合')?.fire('click');

    const directoryMessage = '会成为目录名，需使用小写字母、数字或连字符。';
    expect(root.children[1]?.textContent).toContain(directoryMessage);
    expect(root.children[0]?.textContent).not.toContain(directoryMessage);

    profile.value = 'my-research-kit';
    profile.fire('input');
    elementWithText(root, '\u9884\u89c8\u7ec4\u5408')?.fire('click');
    const sourceMessage = '\u8bf7\u81f3\u5c11\u586b\u5199\u4e00\u4e2a\u6765\u6e90\u3002';
    expect(root.children[1]?.textContent).toContain(sourceMessage);
    expect(root.children[0]?.textContent).not.toContain(sourceMessage);

    source.value = 'https://github.com/dsh-packs/web-dev';
    source.fire('input');
    elementWithText(root, '预览组合')?.fire('click');
    await settle();

    expect(root.children[1]?.textContent).toContain('E_ARCHIVE_ENTRY_SKIPPED');
    expect(root.children[1]?.textContent).toContain(skipped);
    expect(root.children[0]?.textContent).not.toContain(skipped);
  });

  it('renders only structurally valid compose diagnostics with their declared severity', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      {
        status: 200,
        body: {
          diagnostics: [
            { code: 'E_PREVIEW', severity: 'error', message: 'preview error' },
            { code: 'W_PREVIEW', severity: 'warning', message: 'preview warning' },
            { code: 'I_PREVIEW', severity: 'info', message: 'preview info' },
            { code: 'X_PREVIEW', severity: 'unknown', message: 'must not render' },
            { code: 7, severity: 'warning', message: 'must not render' },
            { code: 'W_MISSING_MESSAGE', severity: 'warning' },
          ],
          exitCode: 0,
          metadata: { phase: 'preview', sourceSkills: [], selected: [], conflicts: [] },
        },
      },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    fakes.window.location.hash = '#compose';
    const composeInputs = inputs(root).filter((input) => input.type === 'text');
    const profile = composeInputs[1];
    const source = composeInputs[2];
    if (profile === undefined || source === undefined) throw new Error('expected compose inputs');
    profile.value = 'diagnostic-preview';
    profile.fire('input');
    source.value = 'https://github.com/dsh-packs/web-dev';
    source.fire('input');
    elementWithText(root, '预览组合')?.fire('click');
    await settle();

    const feedback = descendants(root).filter((element) =>
      (element as unknown as { className?: string }).className?.startsWith('compose-feedback'),
    );
    expect(feedback.map((element) => element.textContent)).toEqual([
      'E_PREVIEW: preview error',
      'W_PREVIEW: preview warning',
      'I_PREVIEW: preview info',
    ]);
    expect(
      feedback.map((element) => (element as unknown as { className?: string }).className),
    ).toEqual([
      'compose-feedback compose-feedback-error',
      'compose-feedback compose-feedback-warning',
      'compose-feedback compose-feedback-info',
    ]);
    expect(visibleText(root)).not.toContain('must not render');
  });

  it('requires and serializes a concrete conflict preference before compose install planning', async () => {
    const first = 'https://github.com/dsh-packs/web-dev';
    const second = 'https://github.com/dsh-packs/research-writing';
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      {
        status: 200,
        body: {
          diagnostics: [],
          exitCode: 0,
          metadata: {
            phase: 'preview',
            sourceSkills: [
              { from: first, skills: ['notes'] },
              { from: second, skills: ['notes'] },
            ],
            selected: [
              { from: first, id: 'notes', originalId: 'notes' },
              { from: second, id: 'notes', originalId: 'notes' },
            ],
            conflicts: [{ path: 'skills/notes' }],
          },
        },
      },
      { status: 200, body: planBody },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    fakes.window.location.hash = '#compose';
    let composeInputs = inputs(root).filter((input) => input.type === 'text');
    const profile = composeInputs[1];
    const firstSource = composeInputs[2];
    if (profile === undefined || firstSource === undefined)
      throw new Error('expected compose inputs');
    profile.value = 'merged-notes';
    profile.fire('input');
    firstSource.value = first;
    firstSource.fire('input');
    elementWithText(root, '添加来源')?.fire('click');
    composeInputs = inputs(root).filter((input) => input.type === 'text');
    const secondSource = composeInputs[3];
    if (secondSource === undefined) throw new Error('expected second compose source');
    secondSource.value = second;
    secondSource.fire('input');
    elementWithText(root, '预览组合')?.fire('click');
    await settle();

    expect(visibleText(root)).toContain('skills/notes');
    expect(elementWithText(root, '组装并安装')?.disabled).toBe(true);
    const prefer = inputs(root).find((input) => input.type === 'radio');
    if (prefer === undefined) throw new Error('expected conflict preference');
    prefer.checked = true;
    prefer.fire('change');
    const sourceSelect = descendants(root)
      .filter((element) => element.tagName === 'select')
      .at(-1);
    if (sourceSelect === undefined) throw new Error('expected conflict source selector');
    expect(sourceSelect.disabled).toBe(false);
    expect(sourceSelect.value).toBe(first);
    sourceSelect.value = second;
    sourceSelect.fire('change');
    const install = elementWithText(root, '组装并安装');
    expect(install?.disabled).toBe(false);
    install?.fire('click');
    await settle();

    expect(requestBodies(fakes.calls).at(-1)).toMatchObject({
      operation: 'compose',
      phase: 'plan',
      input: {
        profile: 'merged-notes',
        spec: {
          include: [
            { from: first, skills: ['*'] },
            { from: second, skills: ['*'] },
          ],
          resolve: [{ id: 'skills/notes', prefer: second }],
        },
      },
    });
  });

  it('walks the Chinese compose flow through preview, selected skills, and the existing plan review', async () => {
    const pinned = 'github:dsh-packs/web-dev#0123456789abcdef0123456789abcdef01234567';
    const previewBody = {
      diagnostics: [],
      exitCode: 0,
      metadata: {
        phase: 'preview',
        sourceSkills: [{ from: 'https://github.com/dsh-packs/web-dev', skills: ['notes'] }],
        selected: [{ from: pinned, id: 'notes', originalId: 'notes' }],
        conflicts: [],
      },
    };
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: previewBody },
      { status: 200, body: previewBody },
      { status: 200, body: previewBody },
      { status: 200, body: planBody },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    fakes.window.location.hash = '#compose';
    const composeInputs = inputs(root).filter((input) => input.type === 'text');
    const profile = composeInputs[1];
    const source = composeInputs[2];
    if (profile === undefined || source === undefined) throw new Error('expected compose inputs');
    profile.value = 'x';
    profile.fire('input');
    expect(source.placeholder).toContain('github.com');
    source.value = 'https://github.com/dsh-packs/web-dev';
    source.fire('input');
    elementWithText(root, '预览组合')?.fire('click');
    await settle();
    expect(visibleText(root)).toContain(pinned);

    const skill = inputs(root).find((input) => input.type === 'checkbox');
    if (skill === undefined) throw new Error('expected preview skill checkbox');
    skill.checked = true;
    skill.fire('change');
    elementWithText(root, '预览组合')?.fire('click');
    await settle();
    const install = elementWithText(root, '组装并安装');
    expect(install?.disabled).toBe(false);
    source.value = 'https://github.com/dsh-packs/research-writing';
    source.fire('input');
    expect(install?.disabled).toBe(true);
    install?.fire('click');
    await settle();
    expect(requestBodies(fakes.calls)).toHaveLength(3);
    source.value = 'https://github.com/dsh-packs/web-dev';
    source.fire('input');
    elementWithText(root, '预览组合')?.fire('click');
    await settle();
    const renewedInstall = elementWithText(root, '组装并安装');
    expect(renewedInstall?.disabled).toBe(false);
    renewedInstall?.fire('click');
    await settle();

    const requests = requestBodies(fakes.calls);
    expect(requests.slice(-4)).toMatchObject([
      {
        operation: 'composePreview',
        input: {
          spec: {
            name: 'x-ui',
            include: [{ from: 'https://github.com/dsh-packs/web-dev', skills: ['*'] }],
          },
        },
      },
      {
        operation: 'composePreview',
        input: {
          spec: { include: [{ from: 'https://github.com/dsh-packs/web-dev', skills: ['notes'] }] },
        },
      },
      {
        operation: 'composePreview',
        input: {
          spec: { include: [{ from: 'https://github.com/dsh-packs/web-dev', skills: ['*'] }] },
        },
      },
      { operation: 'compose', phase: 'plan', input: { profile: 'x' } },
    ]);
    expect(fakes.window.location.hash).toBe('#write-review');
  });

  it('does not restore a stale compose preview after its source changes', async () => {
    const pinned = 'github:dsh-packs/web-dev#0123456789abcdef0123456789abcdef01234567';
    const preview = deferredResponse();
    const document = new FakeDocument();
    const window = new FakeWindow('http://127.0.0.1/?token=memory-token#overview');
    const calls: Array<{ readonly input: unknown; readonly init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      calls.push(init === undefined ? { input } : { input, init });
      if (calls.length === 1)
        return {
          status: 200,
          json: async () => statusBody,
        } as Response;
      return preview.promise;
    });
    vi.stubGlobal('window', window);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('HTMLInputElement', FakeInputElement);
    vi.stubGlobal('HTMLSelectElement', FakeElement);
    vi.stubGlobal('HTMLTextAreaElement', FakeTextAreaElement);
    const root = document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'EN')?.fire('click');
    window.location.hash = '#compose';
    const composeInputs = inputs(root).filter((input) => input.type === 'text');
    const profile = composeInputs[1];
    const source = composeInputs[2];
    if (profile === undefined || source === undefined) throw new Error('expected compose inputs');
    profile.value = 'x';
    profile.fire('input');
    source.value = 'https://github.com/dsh-packs/web-dev';
    source.fire('input');
    elementWithText(root, 'Preview composition')?.fire('click');
    await settle();
    expect(calls).toHaveLength(2);

    source.value = 'https://github.com/dsh-packs/research-writing';
    source.fire('input');
    preview.resolve({
      status: 200,
      json: async () => ({
        diagnostics: [],
        exitCode: 0,
        metadata: {
          phase: 'preview',
          sourceSkills: [{ from: 'https://github.com/dsh-packs/web-dev', skills: ['notes'] }],
          selected: [{ from: pinned, id: 'notes', originalId: 'notes' }],
          conflicts: [],
        },
      }),
    } as Response);
    await settle();

    expect(visibleText(root)).not.toContain(pinned);
    const install = elementWithText(root, 'Compose and install');
    expect(install?.disabled).toBe(true);
    install?.fire('click');
    await settle();
    expect(calls).toHaveLength(2);
  });

  it('walks the English skill editor flow and loads external content through textarea.value', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      {
        status: 200,
        body: {
          diagnostics: [],
          exitCode: 0,
          metadata: {
            assetDigests: [{ target: 'skills/notes', digest: 'sha256-notes' }],
            localDrift: [{ kind: 'skill', target: 'skills/notes' }],
          },
        },
      },
      {
        status: 200,
        body: { diagnostics: [], exitCode: 0, metadata: { content: '# outside <tag>\n' } },
      },
      { status: 200, body: planBody },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'EN')?.fire('click');
    fakes.window.location.hash = '#skill-editor';
    const selects = descendants(root).filter((element) => element.tagName === 'select');
    const profile = selects[1];
    if (profile === undefined) throw new Error('expected editor profile select');
    profile.value = 'alpha';
    profile.fire('change');
    await settle();
    expect(visibleText(root)).toContain('notes (Drifted)');
    elementWithText(root, 'notes (Drifted)')?.fire('click');
    await settle();

    const editor = textareas(root)[0];
    if (editor === undefined) throw new Error('expected skill textarea');
    expect(editor.value).toBe('# outside <tag>\n');
    editor.value = '# user-owned notes\n';
    editor.fire('input');
    elementWithText(root, 'Save and review plan')?.fire('click');
    await settle();

    expect(requestBodies(fakes.calls).slice(-3)).toMatchObject([
      { operation: 'diff', input: { profile: 'alpha' } },
      { operation: 'skillContent', input: { profile: 'alpha', skillId: 'notes' } },
      {
        operation: 'editSkill',
        phase: 'plan',
        input: { profile: 'alpha', skillId: 'notes', content: '# user-owned notes\n' },
      },
    ]);
  });

  it('filters malformed editor diff metadata and blocks unsafe skill-content requests', async () => {
    const malformedStatus = {
      diagnostics: [],
      exitCode: 0,
      metadata: {
        profiles: [
          { profile: 'alpha', status: 'tracked' },
          { profile: 'orphan', status: 'untracked' },
          { profile: 7, status: 'tracked' },
          null,
        ],
      },
    };
    const fakes = installBrowserFakes([
      { status: 200, body: malformedStatus },
      {
        status: 200,
        body: {
          diagnostics: [],
          exitCode: 0,
          metadata: {
            assetDigests: [
              { target: 'skills/notes', digest: 'sha256-notes' },
              { target: 'profiles/alpha.yml', digest: 'sha256-ignore' },
              { target: 9, digest: 'sha256-ignore' },
            ],
            localDrift: [
              { kind: 'skill', target: 'skills/draft' },
              { kind: 'profile', target: 'skills/ignored' },
              { kind: 'skill', target: 9 },
            ],
          },
        },
      },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'EN')?.fire('click');
    fakes.window.location.hash = '#skill-editor';
    expect(elementWithText(root, 'Load skill')).toBeDefined();
    elementWithText(root, 'Load skill')?.fire('click');
    await settle();
    expect(requestBodies(fakes.calls)).toHaveLength(1);

    const profile = descendants(root).filter((element) => element.tagName === 'select')[1];
    if (profile === undefined) throw new Error('expected editor profile select');
    profile.value = 'alpha';
    profile.fire('change');
    await settle();

    expect(visibleText(root)).toContain('draft (Drifted)');
    expect(elementWithText(root, 'notes')).toBeDefined();
    expect(visibleText(root)).not.toContain('ignored');
    expect(visibleText(root)).not.toContain('orphan');
    const skill = inputs(root)
      .filter((input) => input.type === 'text')
      .at(-1);
    if (skill === undefined) throw new Error('expected editor skill input');
    skill.value = '../unsafe';
    skill.fire('input');
    elementWithText(root, 'Load skill')?.fire('click');
    await settle();

    expect(requestBodies(fakes.calls)).toHaveLength(2);
    expect(visibleText(root)).toContain('Choose or enter a safe skill ID.');
  });

  it('re-renders all chrome from the runtime locale switch without translating server diagnostics', async () => {
    const serverDiagnostic = 'server diagnostic remains verbatim';
    const serverPath = 'profiles/alpha.yml:4:7';
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      {
        status: 200,
        body: {
          diagnostics: [
            { code: 'E_SERVER', severity: 'error', message: serverDiagnostic, path: serverPath },
          ],
          exitCode: 70,
          metadata: { sideEffects: [] },
        },
      },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    expect(visibleText(root)).toContain('总览');
    expect(visibleText(root)).toContain('预览计划');
    expect(visibleText(root)).toContain('状态概览');

    const operation = descendants(root).find((element) => element.tagName === 'select');
    if (operation === undefined) throw new Error('expected operation selector');
    operation.value = 'update';
    operation.fire('change');
    elementWithText(root, '预览计划')?.fire('click');
    expect(visibleText(root)).toContain('请填写已有 Profile 名后再预览计划。');
    elementWithText(root, 'EN')?.fire('click');
    const english = visibleText(root);
    for (const label of [
      'Overview',
      'Drift comparison',
      'Diagnostics',
      'Pack details',
      'Write review',
      'Preview plan',
      'Status summary',
      'Version',
      'View Profile',
    ])
      expect(english).toContain(label);
    expect(english).toContain('Profile name');
    expect(english).toContain('Enter an existing Profile name before previewing the plan.');

    fakes.window.location.hash = '#doctor';
    await settle();
    const doctor = visibleText(root);
    expect(doctor).toContain('CodeSeverityMessageLocation');
    expect(doctor).toContain('E_SERVER');
    expect(doctor).toContain(serverDiagnostic);
    expect(doctor).toContain(serverPath);

    fakes.window.location.hash = '#pack';
    expect(visibleText(root)).toContain('No provenance is available.');

    elementWithText(root, '中')?.fire('click');
    expect(visibleText(root)).toContain('Pack 详情');
  });

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
    expect(visibleText(activeSections()[0] as FakeElement)).toContain('诊断');
  });

  it('renders each hash-selected screen into the one active mount', async () => {
    const fakes = installBrowserFakes([{ status: 200, body: statusBody }]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    for (const [hash, heading] of [
      ['#profile-diff', '漂移对比'],
      ['#pack', 'Pack 详情'],
      ['#write-review', '写操作审阅'],
      ['#unknown', '总览'],
    ] as const) {
      fakes.window.location.hash = hash;
      const views = descendants(root).filter(
        (element) => element !== root && element.tagName === 'main',
      );
      expect(views).toHaveLength(1);
      expect(visibleText(views[0] as FakeElement)).toContain(heading);
    }
  });

  it('puts the shared target field in explicit Profile diff mode outside write planning', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: { diagnostics: [], exitCode: 0, metadata: {} } },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, '漂移对比')?.fire('click');
    const target = descendants(root).find(
      (element) => element.tagName === 'input' && element.type === 'text',
    );
    expect(visibleText(root)).toContain('用于漂移对比的 Profile 名');
    expect(target?.placeholder).toContain('需要比较的 Profile 名');
    expect(elementWithText(root, '预览计划')?.disabled).toBe(true);
    expect(elementWithText(root, '加载漂移对比')?.disabled).toBe(false);

    if (target === undefined) throw new Error('expected diff target');
    target.value = 'alpha';
    elementWithText(root, '加载漂移对比')?.fire('click');
    await settle();
    expect(requestBodies(fakes.calls).at(-1)).toEqual({
      operation: 'diff',
      input: { profile: 'alpha', checkUpdates: true },
    });
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

    elementWithText(root, '查看 Profile')?.fire('click');
    await settle();
    expect(fakes.window.location.hash).toBe('#profile-diff');
    fakes.window.location.hash = '#write-review';
    const source = descendants(root).find(
      (element) => element.tagName === 'input' && element.type === 'text',
    );
    if (source !== undefined) source.value = '';
    elementWithText(root, '预览写操作')?.fire('click');
    expect(visibleText(root)).toContain('请填写安装来源后再预览计划。');
    elementWithText(root, '重置审阅')?.fire('click');
    fakes.window.location.hash = '#pack';
    expect(elementWithText(root, '查看 Pack 详情')).toBeUndefined();
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
    elementWithText(root, '查看 Pack')?.fire('click');
    await settle();
    expect(fakes.window.location.hash).toBe('#pack');
    expect(visibleText(root)).toContain('from-list-response');

    fakes.window.location.hash = '#overview';
    elementWithText(root, '更新 Profile')?.fire('click');
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

    elementWithText(root, '查看漂移')?.fire('click');
    expect(visibleText(root)).toContain('请先选择一个 Profile，再查看漂移。');
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
      (element) => element.tagName === 'button' && element.textContent === '更新 Profile',
    );
    expect(update).toBeDefined();
    update?.fire('click');

    expect(visibleText(root)).toContain('请先选择一个已跟踪的 Profile，再预览计划。');
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

    elementWithText(root, '更新 Profile')?.fire('click');
    await settle();
    vi.stubGlobal('HTMLInputElement', class NotAnInput {});
    inputs(root)
      .filter((candidate) => candidate.type === 'checkbox')
      .at(0)
      ?.fire('change');

    const ordinaryGrant = inputs(root).find((candidate) => candidate.type === 'checkbox');
    expect(ordinaryGrant?.checked).toBe(false);
    expect(elementWithText(root, '执行已审阅计划')?.disabled).toBe(true);
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

    for (const action of ['更新 Profile', '卸载 Profile', '恢复 Profile']) {
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

    elementWithText(root, '查看漂移')?.fire('click');
    await settle();
    fakes.window.location.hash = '#overview';
    elementWithText(root, '查看 Profile')?.fire('click');
    await settle();
    fakes.window.location.hash = '#overview';
    elementWithText(root, '运行诊断')?.fire('click');
    await settle();
    expect(requestBodies(fakes.calls).filter((body) => body.operation === 'doctor')).toHaveLength(
      1,
    );

    const select = descendants(root).find((element) => element.tagName === 'select');
    const source = descendants(root).find(
      (element) => element.tagName === 'input' && element.type === 'text',
    );
    const plan = elementWithText(root, '预览计划');
    expect(select).toBeDefined();
    expect(source).toBeDefined();
    expect(plan).toBeDefined();
    for (const [operation, value] of [
      ['install', 'tarball:https://example.invalid/pack.tgz#sha512-deadbeef'],
      ['uninstall', 'alpha'],
      ['update', 'alpha'],
      ['restore', 'alpha'],
      ['gc', ''],
    ] as const) {
      if (select !== undefined && source !== undefined) {
        select.value = operation;
        select.fire('change');
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
    expect(writes[0]?.input).toMatchObject({
      source: 'tarball:https://example.invalid/pack.tgz#sha512-deadbeef',
    });
    expect(writes[4]?.input).toEqual({});
  });

  it('makes the write target semantics explicit and blocks a profile-shaped install value locally', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: planWith() },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    const select = descendants(root).find((element) => element.tagName === 'select');
    const source = descendants(root).find(
      (element) => element.tagName === 'input' && element.type === 'text',
    );
    if (select === undefined || source === undefined) throw new Error('expected write form');

    expect(visibleText(root)).toContain('安装来源');
    expect(source.placeholder).toContain('github.com');
    source.value = 'personal-notes';
    elementWithText(root, '预览计划')?.fire('click');
    expect(visibleText(root)).toContain('install 需要来源而非 profile 名');
    expect(requestBodies(fakes.calls)).toEqual([{ operation: 'list', input: {} }]);

    source.value = './examples/compose/sources/personal-notes';
    elementWithText(root, '预览计划')?.fire('click');
    await settle();
    expect(requestBodies(fakes.calls).at(-1)).toMatchObject({
      operation: 'install',
      phase: 'plan',
      input: { source: './examples/compose/sources/personal-notes' },
    });
    expect(visibleText(root)).not.toContain('install 需要来源而非 profile 名');

    source.value = 'https://github.com/dsh-packs/web-dev';
    elementWithText(root, '预览计划')?.fire('click');
    await settle();
    expect(requestBodies(fakes.calls).at(-1)).toMatchObject({
      operation: 'install',
      phase: 'plan',
      input: { source: 'https://github.com/dsh-packs/web-dev' },
    });

    select.value = 'update';
    select.fire('change');
    expect(visibleText(root)).toContain('Profile 名');
    expect(source.placeholder).toContain('已有 profile 名');

    select.value = 'gc';
    select.fire('change');
    expect(visibleText(root)).toContain('无需输入');
    expect(source.disabled).toBe(true);
  });

  it('explains SOURCE_INVALID as an install-source mistake after a server response', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      {
        status: 500,
        body: {
          diagnostics: [
            {
              code: 'SOURCE_INVALID',
              severity: 'error',
              message: '本地 source 不存在或无法读取。',
            },
          ],
          exitCode: 20,
          metadata: {},
        },
      },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    const source = descendants(root).find(
      (element) => element.tagName === 'input' && element.type === 'text',
    );
    if (source === undefined) throw new Error('expected write source');
    source.value = './missing-source';
    elementWithText(root, '预览计划')?.fire('click');
    await settle();

    expect(visibleText(root)).toContain(
      'install 需要来源而非 profile 名；若想操作已有 profile，请选择 update/uninstall/restore。',
    );
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
    elementWithText(root, '预览计划')?.fire('click');
    expect(visibleText(root)).toContain('请选择有效操作。');

    await controller.refreshDiff();
    expect(visibleText(root)).toContain('请先填写 Profile 名，再查看漂移。');
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
    select.fire('change');
    const plan = elementWithText(root, '预览写操作');
    expect(plan).toBeDefined();
    plan?.fire('click');

    expect(visibleText(root)).toContain('请选择有效操作。');
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

    const update = elementWithText(root, '更新 Profile');
    update?.fire('click');
    await settle();
    expect(elementWithText(root, '执行已审阅计划')?.disabled).toBe(true);
    elementWithText(root, '执行已审阅计划')?.fire('click');

    for (const input of inputs(root).filter((candidate) => candidate.type === 'checkbox')) {
      expect(input).toBeDefined();
      input.checked = true;
      input.fire('change');
    }
    const apply = elementWithText(root, '执行已审阅计划');
    expect(apply?.disabled).toBe(false);
    apply?.fire('click');
    await settle();

    expect(visibleText(root)).toContain('缺少授权');
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

    elementWithText(root, '更新 Profile')?.fire('click');
    await settle();
    elementWithText(root, '执行已审阅计划')?.fire('click');
    await settle();
    expect(visibleText(root)).toContain('计划已过期，请重新审阅。');
    elementWithText(root, '重新预览计划')?.fire('click');
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
    expect(visibleText(root)).toContain('UI 服务返回了无效响应。');
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
    elementWithText(root, '总览')?.fire('click');
    expect(activeMount.textContent).toContain('总览');
    expect(activeMount.textContent).not.toContain('tampered active view');
    elementWithText(root, '更新 Profile')?.fire('click');
    await settle();

    vi.stubGlobal('HTMLInputElement', class NotAnInput {});
    for (const input of inputs(root).filter((candidate) => candidate.type === 'checkbox'))
      input.fire('change');
    expect(elementWithText(root, '执行已审阅计划')?.disabled).toBe(true);
    expect(fakes.window.location.hash).toBe('#write-review');
  });

  it('auto-starts with body after readiness and waits for DOMContentLoaded while loading', async () => {
    const ready = installBrowserFakes([{ status: 200, body: statusBody }]);
    vi.stubGlobal('document', ready.document);
    vi.resetModules();
    await import('../src/main.js');
    await settle();
    expect(elementWithText(ready.document.body, 'dshpack 包管理')).toBeDefined();

    vi.unstubAllGlobals();
    const loading = installBrowserFakes([{ status: 200, body: statusBody }]);
    loading.document.readyState = 'loading';
    vi.stubGlobal('document', loading.document);
    vi.resetModules();
    await import('../src/main.js');
    expect(elementWithText(loading.document.body, 'dshpack 包管理')).toBeUndefined();
    loading.document.fire('DOMContentLoaded');
    await settle();
    expect(elementWithText(loading.document.body, 'dshpack 包管理')).toBeDefined();
  });

  it('keeps every compose diagnostic visible, resolves conflicts, and refreshes selected skills', async () => {
    const sourceUrl = 'https://github.com/dsh-packs/web-dev';
    const previewBody = {
      diagnostics: [
        { code: 'E_PREVIEW', severity: 'error', message: 'preview error' },
        { code: 'W_PREVIEW', severity: 'warning', message: 'preview warning' },
        { code: 'I_PREVIEW', severity: 'info', message: 'preview info' },
        { code: 'E_INVALID', severity: 'unexpected', message: 'must not render' },
        { code: 3, severity: 'error', message: 'must not render' },
      ],
      exitCode: 0,
      metadata: {
        phase: 'preview',
        sourceSkills: [
          { from: sourceUrl, skills: ['notes'] },
          { from: sourceUrl, skills: 3 },
        ],
        selected: [null, { from: sourceUrl, id: 'notes', originalId: 'notes' }],
        conflicts: [null, { path: 'skills/notes/SKILL.md' }],
      },
    };
    const fakes = installBrowserFakes([
      { status: 200, body: statusBody },
      { status: 200, body: previewBody },
      { status: 200, body: previewBody },
      { status: 200, body: previewBody },
      { status: 200, body: planBody },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'EN')?.fire('click');
    fakes.window.location.hash = '#compose';
    elementWithText(root, 'Add source')?.fire('click');
    expect(inputs(root).filter((input) => input.type === 'text')).toHaveLength(4);
    const textInputs = inputs(root).filter((input) => input.type === 'text');
    const profile = textInputs[1];
    const source = textInputs[2];
    const secondSource = textInputs[3];
    if (profile === undefined || source === undefined || secondSource === undefined)
      throw new Error('expected compose inputs');
    profile.value = 'research-kit';
    profile.fire('input');
    source.value = sourceUrl;
    source.fire('input');
    secondSource.value = sourceUrl;
    secondSource.fire('input');
    elementWithText(root, 'Preview composition')?.fire('click');
    await settle();

    const firstPreview = visibleText(root);
    expect(firstPreview).toContain('E_PREVIEW: preview error');
    expect(firstPreview).toContain('W_PREVIEW: preview warning');
    expect(firstPreview).toContain('I_PREVIEW: preview info');
    expect(firstPreview).not.toContain('must not render');
    expect(elementWithText(root, 'Compose and install')?.disabled).toBe(true);

    const selectedSkill = inputs(root).find((input) => input.type === 'checkbox');
    if (selectedSkill === undefined) throw new Error('expected source skill');
    selectedSkill.checked = true;
    selectedSkill.fire('change');
    elementWithText(root, 'Preview composition')?.fire('click');
    await settle();
    const deselectedSkill = inputs(root).find((input) => input.type === 'checkbox');
    if (deselectedSkill === undefined) throw new Error('expected refreshed source skill');
    expect(deselectedSkill.checked).toBe(true);
    deselectedSkill.checked = false;
    deselectedSkill.fire('change');
    elementWithText(root, 'Preview composition')?.fire('click');
    await settle();

    const radios = () => inputs(root).filter((input) => input.type === 'radio');
    const prefer = radios()[0];
    if (prefer === undefined) throw new Error('expected prefer resolution');
    prefer.checked = true;
    prefer.fire('change');
    const resolutionSelect = descendants(root)
      .filter((element) => element.tagName === 'select')
      .at(-1);
    if (resolutionSelect === undefined) throw new Error('expected source resolution select');
    resolutionSelect.value = sourceUrl;
    resolutionSelect.fire('change');

    const rename = radios()[1];
    if (rename === undefined) throw new Error('expected rename resolution');
    rename.checked = true;
    rename.fire('change');
    expect(
      descendants(root)
        .filter((element) => element.tagName === 'select')
        .at(-1)?.disabled,
    ).toBe(true);
    expect(elementWithText(root, 'Compose and install')?.disabled).toBe(false);

    elementWithText(root, 'Compose and install')?.fire('click');
    await settle();
    expect(requestBodies(fakes.calls).at(-1)).toMatchObject({
      operation: 'compose',
      phase: 'plan',
      input: { profile: 'research-kit' },
    });
  });

  it('keeps malformed editor and compose inputs conservative before any server write', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: { diagnostics: [], exitCode: 0, metadata: {} } },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'EN')?.fire('click');
    fakes.window.location.hash = '#skill-editor';
    elementWithText(root, 'Load skill')?.fire('click');
    expect(visibleText(root)).toContain('Choose a Profile.');
    const editorSkill = inputs(root).find((input) => input.type === 'text');
    if (editorSkill === undefined) throw new Error('expected editor skill input');
    editorSkill.value = 'bad skill';
    editorSkill.fire('input');
    elementWithText(root, 'Save and review plan')?.fire('click');
    expect(visibleText(root)).toContain('Choose a Profile.');
    expect(requestBodies(fakes.calls)).toEqual([{ operation: 'list', input: {} }]);

    fakes.window.location.hash = '#compose';
    const composeInputs = inputs(root).filter((input) => input.type === 'text');
    const profile = composeInputs[1];
    const source = composeInputs[2];
    if (profile === undefined || source === undefined) throw new Error('expected compose inputs');
    vi.stubGlobal('HTMLInputElement', class NotAnInput {});
    profile.value = 'ignored-profile';
    profile.fire('input');
    source.value = 'ignored-source';
    source.fire('input');
    elementWithText(root, 'Preview composition')?.fire('click');
    expect(visibleText(root)).toContain(
      'The Profile name becomes a directory name; use lowercase letters, digits, or hyphens.',
    );
  });

  it('filters malformed editor metadata while retaining a valid drifted skill', async () => {
    const fakes = installBrowserFakes([
      { status: 200, body: { diagnostics: [], exitCode: 0, metadata: { profiles: 'not-a-list' } } },
      {
        status: 200,
        body: {
          diagnostics: [],
          exitCode: 0,
          metadata: {
            assetDigests: [null, { target: 3 }, { target: 'settings.json' }],
            localDrift: [
              null,
              { kind: 'other', target: 'skills/skip' },
              { kind: 'skill', target: 'skills/notes' },
            ],
          },
        },
      },
      { status: 200, body: { diagnostics: [], exitCode: 0, metadata: { content: 3 } } },
    ]);
    const root = fakes.document.createElement('main');
    startBrowserUi(root as unknown as HTMLElement);
    await settle();

    elementWithText(root, 'EN')?.fire('click');
    fakes.window.location.hash = '#skill-editor';
    const profile = descendants(root).filter((element) => element.tagName === 'select')[1];
    if (profile === undefined) throw new Error('expected editor profile select');
    profile.value = 'alpha';
    profile.fire('change');
    await settle();
    expect(elementWithText(root, 'notes (Drifted)')).toBeDefined();

    const skill = inputs(root).find((input) => input.type === 'text');
    if (skill === undefined) throw new Error('expected editor skill');
    skill.value = 'bad skill';
    skill.fire('input');
    elementWithText(root, 'Load skill')?.fire('click');
    expect(visibleText(root)).toContain('Choose or enter a safe skill ID.');

    elementWithText(root, 'notes (Drifted)')?.fire('click');
    await settle();
    const content = textareas(root)[0];
    expect(content?.value).toBe('');
  });
});
