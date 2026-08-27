import { readFileSync } from 'node:fs';
import type { UiDangerousPermission, UiResponse, UiWriteRequest } from 'dshpack';
import { describe, expect, it } from 'vitest';
import { createBrowserState, reduceBrowserState } from '../src/state.js';
import {
  type BrowserControlNode,
  type BrowserElementNode,
  type BrowserViewNode,
  renderBrowserView,
  textContent,
} from '../src/view.js';

const hostilePack = '<img src=x onerror=alert(1)>';
const hostileSkill = '<script>steal()</script>';
const hostileDiagnostic = '<img src=x onerror=alert(2)>';
const hostileUrl = 'https://example.invalid/<img src=x onerror=alert(3)>';

const buildPermission = {
  kind: 'allow-build',
  subject: hostileSkill,
} as const satisfies UiDangerousPermission;

const fullAccessPermission = {
  kind: 'danger-full-access',
  subject: hostilePack,
} as const satisfies UiDangerousPermission;

const request = {
  operation: 'install',
  phase: 'plan',
  input: { source: 'https://example.invalid/pack.tgz' },
  authorizedDangerousPermissions: [],
} as const satisfies UiWriteRequest;

const planResponse: UiResponse = {
  diagnostics: [
    {
      code: 'E_HOSTILE',
      severity: 'error',
      message: hostileDiagnostic,
      path: `src/${hostileSkill}:4:7`,
      hint: 'inspect',
      evidence: 'local',
    },
  ],
  exitCode: 0 as UiResponse['exitCode'],
  metadata: {
    profile: 'research',
    profiles: [
      {
        profile: 'research',
        status: 'tracked',
        pack: { name: hostilePack, version: '1.2.3' },
        drift: 2,
        sharedAssets: 1,
        update: 'available',
      },
    ],
    localDrift: [
      {
        kind: 'skill',
        id: hostileSkill,
        target: `skills/${hostileSkill}.md`,
        mergeAction: 'update',
        base: 'present',
        current: 'present',
        targetState: 'present',
        currentSha256: 'sha256-current',
      },
    ],
    upstreamDelta: [],
    effectiveMismatch: [],
    generation: 3,
    assetDigests: [{ target: `skills/${hostileSkill}.md`, digest: 'sha256-asset' }],
    sideEffects: [{ owner: 'dsh', path: 'profile/cordis.yml' }],
    plan: {
      manifest: { name: hostilePack, version: '1.2.3', skills: [hostileSkill] },
      provenance: [{ id: hostileSkill, from: hostileUrl, license: 'MIT' }],
      lock: { lockVersion: 0, manifestSha256: 'sha256-manifest', files: [] },
    },
    planDigest: 'sha256-review-digest-long-value',
    requiredDangerousPermissions: [buildPermission, fullAccessPermission],
  },
};

const reviewedPlanResponse: UiResponse = {
  diagnostics: [],
  exitCode: 0 as UiResponse['exitCode'],
  metadata: {
    plan: { operation: 'update', profile: 'research' },
    planDigest: 'sha256-reviewed-plan',
    requiredDangerousPermissions: [],
  },
};

const completedResponse: UiResponse = {
  diagnostics: [
    {
      code: 'I_APPLIED',
      severity: 'info',
      message: 'Applied reviewed plan.',
      path: 'profiles/research.yml:12:7',
      hint: 'This hint must not be rendered.',
      evidence: 'local',
    },
  ],
  exitCode: 0 as UiResponse['exitCode'],
  metadata: { applied: { profile: 'research', generation: 8 } },
};

const planFailureResponse: UiResponse = {
  diagnostics: [
    {
      code: 'E_PLAN_FAILED',
      severity: 'error',
      message: 'The write plan could not be prepared.',
      path: 'packs/research/pack.yml:4:11',
      hint: 'This hint must not be rendered.',
      evidence: 'local',
    },
  ],
  exitCode: 70 as UiResponse['exitCode'],
  metadata: {},
};

const staleResponse: UiResponse = {
  diagnostics: [
    {
      code: 'E_PLAN_STALE',
      severity: 'warning',
      message: 'The reviewed plan changed before apply.',
      path: 'profiles/research.yml:18:3',
      hint: 'This hint must not be rendered.',
      evidence: 'local',
    },
  ],
  exitCode: 24 as UiResponse['exitCode'],
  metadata: {},
};

const invalidLocationResponse: UiResponse = {
  diagnostics: [
    {
      code: 'E_NO_LOCATION',
      severity: 'error',
      message: 'The server supplied no location.',
      hint: 'This hint must not be rendered.',
      evidence: 'local',
    },
    {
      code: 'E_MALFORMED_LOCATION',
      severity: 'warning',
      message: 'The server supplied a malformed location.',
      path: 'profiles/research.yml:12',
      hint: 'This hint must not be rendered.',
      evidence: 'local',
    },
    {
      code: 'E_NEWLINE_LOCATION',
      severity: 'warning',
      message: 'The server supplied a newline-prefixed location.',
      path: 'credential-prefix\nprofiles/research.yml:12:7',
      hint: 'This hint must not be rendered.',
      evidence: 'local',
    },
  ],
  exitCode: 70 as UiResponse['exitCode'],
  metadata: {},
};

const legacyLocationSentinel = 'sk-legacy-credential-sentinel-123456789';
const legacyLocationResponse = {
  diagnostics: [
    {
      code: 'E_LEGACY_LOCATION',
      severity: 'error',
      message: 'Legacy fields must not determine a location.',
      location: { path: `${legacyLocationSentinel}:12:7` },
      line: 12,
      column: 7,
      hint: 'This hint must not be rendered.',
      evidence: 'local',
    },
  ],
  exitCode: 70,
  metadata: {},
} as unknown as UiResponse;

function planningState() {
  return reduceBrowserState(createBrowserState(), { type: 'plan', request });
}

function reviewingState() {
  return reduceBrowserState(planningState(), {
    type: 'plan-success',
    response: reviewedPlanResponse,
  });
}

function nodes(root: BrowserViewNode): BrowserViewNode[] {
  const children = root.type === 'text' ? [] : root.children;
  return [root, ...children.flatMap(nodes)];
}

function elements(root: BrowserViewNode): BrowserElementNode[] {
  return nodes(root).filter((node): node is BrowserElementNode => node.type === 'element');
}

function stringsOutsideText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOutsideText);
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(stringsOutsideText);
  return [];
}

function stringsInNonTextNodes(root: BrowserViewNode): string[] {
  if (root.type === 'text') return [];
  const own = Object.entries(root)
    .filter(([key]) => key !== 'children')
    .flatMap(([, value]) => stringsOutsideText(value));
  return [...own, ...root.children.flatMap(stringsInNonTextNodes)];
}

describe('browser view description tree', () => {
  it('renders overview profile state, counts, and actions without DOM dependencies', () => {
    const tree = renderBrowserView({
      kind: 'overview',
      data: planResponse.metadata,
    });
    expect(tree.type).toBe('element');
    expect(textContent(tree)).toContain(hostilePack);
    expect(textContent(tree)).toContain('drift');
    expect(textContent(tree)).toContain('available');
    expect(textContent(tree)).toContain('untracked: 0');
    expect(textContent(tree)).toContain('reserved: 0');
    expect(textContent(tree)).toContain('broken: 0');
    expect(nodes(tree).some((node) => node.type === 'control')).toBe(true);
    const rowActions = nodes(tree).filter(
      (node): node is BrowserControlNode =>
        node.type === 'control' && (node.action === 'view-profile' || node.action === 'view-diff'),
    );
    expect(rowActions.map((node) => node.itemIndex)).toEqual([0, 0]);
  });

  it('keeps hostile pack and skill values in text nodes only', () => {
    const tree = renderBrowserView({ kind: 'overview', data: planResponse.metadata });
    const all = nodes(tree);
    expect(all.filter((node) => node.type === 'text').map((node) => node.text)).toContain(
      hostilePack,
    );
    const diffTree = renderBrowserView({ kind: 'profile-diff', data: planResponse.metadata });
    expect(
      nodes(diffTree)
        .filter((node) => node.type === 'text')
        .map((node) => node.text),
    ).toContain(hostileSkill);
    expect(
      elements(tree).some((node) => {
        const tag = node.tag as string;
        return tag === 'img' || tag === 'script';
      }),
    ).toBe(false);
    expect(
      elements(tree).some((node) =>
        Object.values(node.attrs ?? {}).some((value) => String(value).includes('onerror')),
      ),
    ).toBe(false);
    expect(stringsInNonTextNodes(tree)).not.toContain(hostilePack);
    expect(stringsInNonTextNodes(diffTree)).not.toContain(hostileSkill);
  });

  it('renders profile diff in three sections with a short digest', () => {
    const tree = renderBrowserView({ kind: 'profile-diff', data: planResponse.metadata });
    const content = textContent(tree);
    expect(content).toContain('local drift');
    expect(content).toContain('upstream delta');
    expect(content).toContain('effective mismatch');
    expect(content).toContain('sha256-revie');
    expect(content).not.toContain('sha256-review');
  });

  it('renders fixed status counts, generation, and inline profile operations', () => {
    const tree = renderBrowserView({
      kind: 'overview',
      data: {
        profiles: [
          {
            profile: 'tracked',
            status: 'tracked',
            pack: { name: 'pack-a', version: '1.0.0' },
            generation: 7,
            drift: 0,
            sharedAssets: 0,
            update: 'none',
          },
          { profile: 'untracked', status: 'untracked' },
          { profile: 'reserved', status: 'reserved' },
          { profile: 'broken', status: 'broken' },
        ],
      },
    });
    const content = textContent(tree);
    for (const status of ['tracked', 'untracked', 'reserved', 'broken'])
      expect(content).toContain(`${status}: 1`);
    expect(content).toContain('generation: 7');

    const operations = nodes(tree).filter(
      (node): node is BrowserControlNode =>
        node.type === 'control' &&
        (node.action === 'update' || node.action === 'uninstall' || node.action === 'restore'),
    );
    expect(operations.map((node) => [node.action, node.itemIndex])).toEqual([
      ['update', 0],
      ['uninstall', 0],
      ['restore', 0],
    ]);
  });

  it('renders doctor diagnostics with location and side-effect owner as text', () => {
    const tree = renderBrowserView({ kind: 'doctor', data: planResponse });
    const content = textContent(tree);
    expect(content).toContain(hostileDiagnostic);
    expect(content).toContain(`src/${hostileSkill}:4:7`);
    expect(content).toContain('owner: dsh');
    expect(
      elements(tree).some((node) => {
        const tag = node.tag as string;
        return tag === 'img' || tag === 'script';
      }),
    ).toBe(false);
    expect(stringsInNonTextNodes(tree)).not.toContain(hostileDiagnostic);
  });

  it('renders pack manifest, provenance, and lock as collapsible sections, with URL text only', () => {
    const tree = renderBrowserView({ kind: 'pack', data: planResponse.metadata });
    const all = nodes(tree);
    const content = textContent(tree);
    expect(content).toContain('manifest');
    expect(content).toContain('provenance');
    expect(content).toContain('lock');
    expect(content).toContain(hostileUrl);
    expect(all.some((node) => node.type === 'text' && node.text === hostileUrl)).toBe(true);
    expect(elements(tree).filter((node) => node.tag === 'details')).toHaveLength(3);
    expect(
      elements(tree).some((node) => {
        const tag = node.tag as string;
        return tag === 'a' || tag === 'img';
      }),
    ).toBe(false);
    expect(all.some((node) => node.type === 'text' && node.text === hostilePack)).toBe(true);
    expect(stringsInNonTextNodes(tree)).not.toContain(hostileUrl);
    expect(all.some((node) => node.type === 'control' && node.action === 'view-pack')).toBe(false);
  });

  it('renders an explicit progress indicator while applying a reviewed plan', () => {
    const applying = reduceBrowserState(reviewingState(), { type: 'apply' });
    const tree = renderBrowserView({ kind: 'write-review', state: applying });

    expect(textContent(tree)).toContain('Applying reviewed plan');
    expect(nodes(tree).some((node) => node.type === 'control' && node.action === 'apply')).toBe(
      false,
    );
  });

  it('renders the completed execution report and its safe diagnostic fields', () => {
    const applying = reduceBrowserState(reviewingState(), { type: 'apply' });
    const done = reduceBrowserState(applying, {
      type: 'apply-response',
      response: completedResponse,
      httpStatus: 200,
    });
    const tree = renderBrowserView({ kind: 'write-review', state: done });
    const content = textContent(tree);

    expect(content).toContain('execution result');
    expect(content).toContain('generation');
    expect(content).toContain('I_APPLIED');
    expect(content).toContain('info');
    expect(content).toContain('Applied reviewed plan.');
    expect(content).toContain('profiles/research.yml:12:7');
    expect(content).toContain(
      'code: I_APPLIED | severity: info | message: Applied reviewed plan. | location: profiles/research.yml:12:7',
    );
    expect(content).not.toContain('This hint must not be rendered.');
    expect(content).not.toContain('local');
    expect(stringsInNonTextNodes(tree)).not.toContain('Applied reviewed plan.');
  });

  it('renders each plan failure diagnostic without hints or evidence', () => {
    const failed = reduceBrowserState(planningState(), {
      type: 'plan-success',
      response: planFailureResponse,
      httpStatus: 500,
    });
    const tree = renderBrowserView({ kind: 'write-review', state: failed });
    const content = textContent(tree);

    expect(content).toContain('E_PLAN_FAILED');
    expect(content).toContain('error');
    expect(content).toContain('The write plan could not be prepared.');
    expect(content).toContain('packs/research/pack.yml:4:11');
    expect(content).toContain('Write operation failed');
    expect(content).not.toContain('plan failed');
    expect(content).toContain(
      'code: E_PLAN_FAILED | severity: error | message: The write plan could not be prepared. | location: packs/research/pack.yml:4:11',
    );
    expect(content).not.toContain('This hint must not be rendered.');
    expect(content).not.toContain('local');
    expect(stringsInNonTextNodes(tree)).not.toContain('The write plan could not be prepared.');
  });

  it('renders each stale-plan diagnostic without hints or evidence', () => {
    const stale = reduceBrowserState(planningState(), {
      type: 'plan-success',
      response: staleResponse,
      httpStatus: 409,
    });
    const tree = renderBrowserView({ kind: 'write-review', state: stale });
    const content = textContent(tree);

    expect(content).toContain('E_PLAN_STALE');
    expect(content).toContain('warning');
    expect(content).toContain('The reviewed plan changed before apply.');
    expect(content).toContain('profiles/research.yml:18:3');
    expect(content).toContain(
      'code: E_PLAN_STALE | severity: warning | message: The reviewed plan changed before apply. | location: profiles/research.yml:18:3',
    );
    expect(content).not.toContain('This hint must not be rendered.');
    expect(content).not.toContain('local');
    expect(stringsInNonTextNodes(tree)).not.toContain('The reviewed plan changed before apply.');
  });

  it('omits absent and malformed diagnostic locations without synthesizing one', () => {
    const applying = reduceBrowserState(reviewingState(), { type: 'apply' });
    const done = reduceBrowserState(applying, {
      type: 'apply-response',
      response: invalidLocationResponse,
      httpStatus: 200,
    });
    const tree = renderBrowserView({ kind: 'write-review', state: done });
    const content = textContent(tree);

    expect(content).toContain('E_NO_LOCATION');
    expect(content).toContain('E_MALFORMED_LOCATION');
    expect(content).toContain('E_NEWLINE_LOCATION');
    expect(content).not.toContain('profiles/research.yml:12');
    expect(content).not.toContain('credential-prefix');
    expect(content).not.toContain(':undefined');
    expect(content).not.toContain('This hint must not be rendered.');
    expect(content).not.toContain('local');
  });

  it('omits legacy diagnostic location fields and their credential-shaped values from the full tree', () => {
    const applying = reduceBrowserState(reviewingState(), { type: 'apply' });
    const done = reduceBrowserState(applying, {
      type: 'apply-response',
      response: legacyLocationResponse,
      httpStatus: 200,
    });
    const tree = renderBrowserView({ kind: 'write-review', state: done });

    expect(textContent(tree)).toContain('E_LEGACY_LOCATION');
    expect(textContent(tree)).not.toContain(legacyLocationSentinel);
    expect(
      nodes(tree)
        .filter((node) => node.type === 'text')
        .map((node) => node.text),
    ).not.toContain(legacyLocationSentinel);
    expect(JSON.stringify(tree)).not.toContain(legacyLocationSentinel);
  });

  it('does not reintroduce non-contract location fields into the renderer', () => {
    const source = readFileSync(new URL('../src/view.ts', import.meta.url), 'utf8');

    for (const unsupportedField of [
      'value.location',
      'location.path',
      'value.line',
      'location.line',
      'value.column',
      'location.column',
    ])
      expect(source).not.toContain(unsupportedField);
  });

  it('keeps malformed read payloads inert while rendering each safe fallback representation', () => {
    const overview = renderBrowserView({
      kind: 'overview',
      data: {
        profiles: [
          {
            profile: 7,
            status: false,
            pack: 'not-a-record',
            drift: 'unknown',
            sharedAssets: null,
            update: 3,
            packDetails: 'not-a-record',
          },
          null,
        ],
      },
    });
    const overviewContent = textContent(overview);
    expect(overviewContent).toContain('unknown');
    expect(overviewContent).toContain('drift: unknown');
    expect(
      nodes(overview).some((node) => node.type === 'control' && node.action === 'view-pack'),
    ).toBe(false);

    const diff = renderBrowserView({
      kind: 'profile-diff',
      data: {
        planDigest: 7,
        localDrift: [null, { id: 9, target: false, mergeAction: {}, currentSha256: 8 }],
        upstreamDelta: 'not-an-array',
        effectiveMismatch: {},
      },
    });
    expect(textContent(diff)).toContain('digest: ');

    const doctor = renderBrowserView({
      kind: 'doctor',
      data: {
        diagnostics: [null, { code: 7, severity: false, message: {}, path: 'not-a-location' }],
        metadata: { sideEffects: [null, { owner: 7, path: false }] },
      },
    });
    expect(textContent(doctor)).toContain('code:  | severity:  | message: ');
    expect(textContent(doctor)).not.toContain('not-a-location');
  });

  it('uses source and empty pack fallbacks, all permission display variants, and supplied read fallback data', () => {
    const fromSourceFallback = renderBrowserView({
      kind: 'pack',
      data: {
        plan: {},
        manifest: { source: 'outer-manifest' },
        provenance: [{ source: 'outer-provenance' }],
        lock: { source: 'outer-lock' },
      },
    });
    expect(textContent(fromSourceFallback)).toContain('outer-manifest');
    expect(textContent(fromSourceFallback)).toContain('outer-provenance');
    expect(textContent(fromSourceFallback)).toContain('outer-lock');
    const emptyFallback = renderBrowserView({
      kind: 'pack',
      data: { plan: { manifest: null, provenance: null, lock: null } },
    });
    expect(textContent(emptyFallback)).toContain('manifest');
    const primitivePackValues = renderBrowserView({
      kind: 'pack',
      data: { plan: { manifest: 7, provenance: true, lock: Symbol('inert-value') } },
    });
    expect(textContent(primitivePackValues)).toContain('7');
    expect(textContent(primitivePackValues)).toContain('true');
    expect(textContent(primitivePackValues)).toContain('[object]');

    const allPermissions = [
      { kind: 'new-plugin', subject: 'plugins/alpha', identity: 'alpha@1.0.0' },
      { kind: 'version-mismatch', subject: 'dsh', tested: ['1.0.0', '2.0.0'] },
    ] as const satisfies readonly UiDangerousPermission[];
    const reviewing = reduceBrowserState(planningState(), {
      type: 'plan-success',
      response: {
        diagnostics: [],
        exitCode: 0 as UiResponse['exitCode'],
        metadata: {
          plan: { operation: 'install' },
          planDigest: 'sha256-permission-display',
          requiredDangerousPermissions: allPermissions,
        },
      },
    });
    if (reviewing.phase !== 'reviewing') throw new Error('expected reviewing state');
    const review = renderBrowserView({
      kind: 'write-review',
      state: { ...reviewing, highlightedMissing: [] },
    });
    expect(textContent(review)).toContain('new-plugin: plugins/alpha (alpha@1.0.0)');
    expect(textContent(review)).toContain('version-mismatch: dsh (1.0.0, 2.0.0)');
    expect(textContent(review)).toContain('missing permissions');

    expect(
      textContent(renderBrowserView({ kind: 'overview' }, { profiles: [{ status: 'tracked' }] })),
    ).toContain('tracked: 1');
    expect(
      textContent(renderBrowserView({ kind: 'profile-diff' }, { planDigest: 'fallback-digest' })),
    ).toContain('fallback-dig');
    expect(textContent(renderBrowserView({ kind: 'doctor', report: planResponse }))).toContain(
      hostileDiagnostic,
    );
    expect(
      textContent(renderBrowserView({ kind: 'pack' }, { manifest: { source: 'fallback' } })),
    ).toContain('fallback');
    expect(textContent(renderBrowserView({ kind: 'doctor', data: { sideEffects: [] } }))).toContain(
      'doctor',
    );
  });

  it('renders one unified write review and never exposes a bulk-consent control', () => {
    const planning = reduceBrowserState(createBrowserState(), { type: 'plan', request });
    const reviewing = reduceBrowserState(planning, {
      type: 'plan-success',
      response: planResponse,
    });
    const tree = renderBrowserView({ kind: 'write-review', state: reviewing });
    const all = nodes(tree);
    const controls = all.filter((node) => node.type === 'control');
    expect(textContent(tree)).toContain('review');
    expect(controls.some((node) => /all|bulk|全部|一键/iu.test(node.label))).toBe(false);
    expect(controls.some((node) => node.action === 'grant')).toBe(true);
    const grantControls = controls.filter((node) => node.action === 'grant');
    expect(grantControls.every((node) => node.control === 'checkbox')).toBe(true);
    expect(grantControls.some((node) => node.checked === false)).toBe(true);
    expect(controls.some((node) => node.action === 'confirm-danger-full-access')).toBe(true);
    expect(controls.find((node) => node.action === 'apply')).toMatchObject({ disabled: true });
  });
});
