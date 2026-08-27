import type { UiDangerousPermission, UiRequest, UiResponse, UiWriteRequest } from 'dshpack';

import { type BrowserState, canApply } from './state.js';

export type BrowserViewTag =
  | 'main'
  | 'section'
  | 'header'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'p'
  | 'ul'
  | 'li'
  | 'dl'
  | 'dt'
  | 'dd'
  | 'details'
  | 'summary'
  | 'table'
  | 'thead'
  | 'tbody'
  | 'tr'
  | 'th'
  | 'td'
  | 'code';

export type BrowserControlKind = 'button' | 'checkbox';
export type BrowserControlAction =
  | 'plan'
  | 'retry-plan'
  | 'view-profile'
  | 'view-diff'
  | 'view-doctor'
  | 'view-pack'
  | 'update'
  | 'uninstall'
  | 'restore'
  | 'grant'
  | 'confirm-danger-full-access'
  | 'apply'
  | 'reset';

export interface BrowserTextNode {
  readonly type: 'text';
  readonly text: string;
}

export interface BrowserElementNode {
  readonly type: 'element';
  readonly tag: BrowserViewTag;
  readonly children: readonly BrowserViewNode[];
  /** The only allowed attribute is a fixed disclosure state, never user data. */
  readonly attrs?: Readonly<Partial<Record<'open', boolean>>>;
}

export interface BrowserControlNode {
  readonly type: 'control';
  readonly control: BrowserControlKind;
  readonly action: BrowserControlAction;
  readonly label: string;
  readonly disabled: boolean;
  readonly checked?: boolean;
  /** An index lets a DOM adapter recover an item without serializing user data into attributes. */
  readonly itemIndex?: number;
  readonly children: readonly BrowserTextNode[];
}

export type BrowserViewNode = BrowserTextNode | BrowserElementNode | BrowserControlNode;

export type BrowserViewKind = 'overview' | 'profile-diff' | 'doctor' | 'pack' | 'write-review';

export interface BrowserViewInput {
  readonly kind: BrowserViewKind;
  readonly data?: unknown;
  readonly state?: BrowserState;
  /** These type-level handles intentionally stay on the shared wire contract. */
  readonly request?: UiRequest;
  readonly writeRequest?: UiWriteRequest;
  readonly report?: UiResponse;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): BrowserTextNode {
  if (typeof value === 'string') return { type: 'text', text: value };
  if (typeof value === 'number' || typeof value === 'boolean')
    return { type: 'text', text: String(value) };
  if (value === null || value === undefined) return { type: 'text', text: '' };
  return { type: 'text', text: '[object]' };
}

function element(tag: BrowserViewTag, children: readonly BrowserViewNode[]): BrowserElementNode {
  return { type: 'element', tag, children };
}

function disclosure(label: string, children: readonly BrowserViewNode[]): BrowserElementNode {
  return {
    type: 'element',
    tag: 'details',
    children: [element('summary', [text(label)]), ...children],
  };
}

function control(
  action: BrowserControlAction,
  label: string,
  options: {
    readonly control?: BrowserControlKind;
    readonly disabled?: boolean;
    readonly checked?: boolean;
    readonly itemIndex?: number;
  } = {},
): BrowserControlNode {
  return {
    type: 'control',
    control: options.control ?? 'button',
    action,
    label,
    disabled: options.disabled ?? false,
    ...(options.checked === undefined ? {} : { checked: options.checked }),
    ...(options.itemIndex === undefined ? {} : { itemIndex: options.itemIndex }),
    children: [text(label)],
  };
}

function contents(value: unknown): readonly BrowserViewNode[] {
  if (value === null || value === undefined || typeof value !== 'object') return [text(value)];
  if (Array.isArray(value))
    return [
      element(
        'ul',
        value.map((item) => element('li', contents(item))),
      ),
    ];
  if (!record(value)) return [text(value)];
  const rows: BrowserViewNode[] = [];
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'))) {
    rows.push(element('dt', [text(key)]), element('dd', contents(value[key])));
  }
  return [element('dl', rows)];
}

function metadata(value: unknown): Record<string, unknown> {
  if (!record(value)) return {};
  if (Array.isArray(value.diagnostics) && record(value.metadata)) return value.metadata;
  return value;
}

function response(value: unknown): Record<string, unknown> | undefined {
  return record(value) && Array.isArray(value.diagnostics) && record(value.metadata)
    ? value
    : undefined;
}

function shortDigest(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 12) : '';
}

function formatLocation(value: Record<string, unknown>): string {
  const path = typeof value.path === 'string' ? value.path : '';
  return /^.+:\d+:\d+$/u.test(path) ? path : '';
}

function diagnosticRows(value: unknown): BrowserElementNode {
  const report = record(value) ? value : {};
  const diagnostics = array(report.diagnostics).filter(record);
  return element(
    'ul',
    diagnostics.map((item) => {
      const location = formatLocation(item);
      return element('li', [
        text('code: '),
        text(typeof item.code === 'string' ? item.code : ''),
        text(' | severity: '),
        text(typeof item.severity === 'string' ? item.severity : ''),
        text(' | message: '),
        text(typeof item.message === 'string' ? item.message : ''),
        ...(location === '' ? [] : [text(' | location: '), text(location)]),
      ]);
    }),
  );
}

function diagnosticsSection(value: unknown): BrowserElementNode {
  return element('section', [element('h2', [text('diagnostics')]), diagnosticRows(value)]);
}

function overview(data: unknown): BrowserViewNode {
  const source = metadata(data);
  const profiles = array(source.profiles).filter(record);
  const statuses = ['tracked', 'untracked', 'reserved', 'broken'] as const;
  const count = (status: (typeof statuses)[number]): number =>
    profiles.filter((profile) => profile.status === status).length;
  const tracked = count('tracked');
  const countNodes = statuses.map((status) => element('li', [text(`${status}: ${count(status)}`)]));
  const profileNodes = profiles.map((profile, index) => {
    const pack = record(profile.pack) ? profile.pack : {};
    const tracked = profile.status === 'tracked';
    return element('li', [
      text(typeof profile.profile === 'string' ? profile.profile : ''),
      text(typeof profile.status === 'string' ? profile.status : 'unknown'),
      element('ul', [
        element('li', [text('pack: '), text(typeof pack.name === 'string' ? pack.name : '')]),
        element('li', [
          text('version: '),
          text(typeof pack.version === 'string' ? pack.version : ''),
        ]),
        element('li', [
          text('drift: '),
          text(typeof profile.drift === 'number' ? profile.drift : 'unknown'),
        ]),
        element('li', [
          text('shared assets: '),
          text(typeof profile.sharedAssets === 'number' ? profile.sharedAssets : 'unknown'),
        ]),
        element('li', [
          text('update: '),
          text(typeof profile.update === 'string' ? profile.update : 'unknown'),
        ]),
        ...(typeof profile.generation === 'number'
          ? [element('li', [text('generation: '), text(profile.generation)])]
          : []),
      ]),
      control('view-profile', 'View profile', { itemIndex: index }),
      control('view-diff', 'View diff', { itemIndex: index }),
      ...(record(profile.packDetails)
        ? [control('view-pack', 'View pack', { itemIndex: index })]
        : []),
      ...(tracked
        ? [
            control('update', 'Update profile', { itemIndex: index }),
            control('uninstall', 'Uninstall profile', { itemIndex: index }),
            control('restore', 'Restore profile', { itemIndex: index }),
          ]
        : []),
    ]);
  });
  return element('main', [
    element('header', [element('h1', [text('profiles')])]),
    element('p', [text(`tracked: ${tracked}`)]),
    element('ul', countNodes),
    element('ul', profileNodes),
    control('view-doctor', 'Run doctor'),
  ]);
}

function diffItems(items: readonly unknown[]): BrowserElementNode {
  return element(
    'ul',
    items.map((item) => {
      const row = record(item) ? item : {};
      return element('li', [
        text(typeof row.id === 'string' ? row.id : ''),
        text(typeof row.target === 'string' ? row.target : ''),
        text(typeof row.mergeAction === 'string' ? row.mergeAction : ''),
        text(typeof row.currentSha256 === 'string' ? shortDigest(row.currentSha256) : ''),
      ]);
    }),
  );
}

function profileDiff(data: unknown): BrowserViewNode {
  const source = metadata(data);
  return element('main', [
    element('header', [
      element('h1', [text('profile diff')]),
      element('p', [text(`digest: ${shortDigest(source.planDigest)}`)]),
    ]),
    element('section', [element('h2', [text('local drift')]), diffItems(array(source.localDrift))]),
    element('section', [
      element('h2', [text('upstream delta')]),
      diffItems(array(source.upstreamDelta)),
    ]),
    element('section', [
      element('h2', [text('effective mismatch')]),
      diffItems(array(source.effectiveMismatch)),
    ]),
  ]);
}

function doctor(data: unknown): BrowserViewNode {
  const report = response(data);
  const source = report === undefined ? metadata(data) : report;
  const reportMetadata = report === undefined ? source : metadata(report);
  const sideEffects = array(reportMetadata.sideEffects).filter(record);
  return element('main', [
    element('header', [element('h1', [text('doctor')])]),
    diagnosticsSection(source),
    element('section', [
      element('h2', [text('side effects')]),
      element(
        'ul',
        sideEffects.map((item) =>
          element('li', [
            text(`owner: ${typeof item.owner === 'string' ? item.owner : ''}`),
            text(typeof item.path === 'string' ? item.path : ''),
          ]),
        ),
      ),
    ]),
  ]);
}

function pack(data: unknown): BrowserViewNode {
  const source = metadata(data);
  const plan = record(source.plan) ? source.plan : source;
  const manifest = plan.manifest ?? source.manifest ?? {};
  const provenance = plan.provenance ?? source.provenance ?? [];
  const lock = plan.lock ?? source.lock ?? {};
  return element('main', [
    element('header', [element('h1', [text('pack')])]),
    disclosure('manifest', contents(manifest)),
    disclosure('provenance', contents(provenance)),
    disclosure('lock', contents(lock)),
  ]);
}

function permissionText(item: UiDangerousPermission): string {
  switch (item.kind) {
    case 'new-plugin':
      return `${item.kind}: ${item.subject} (${item.identity})`;
    case 'version-mismatch':
      return `${item.kind}: ${item.subject} (${item.tested.join(', ')})`;
    default:
      return `${item.kind}: ${item.subject}`;
  }
}

function writeReview(state: BrowserState | undefined): BrowserViewNode {
  if (state === undefined || state.phase === 'idle')
    return element('main', [
      element('header', [element('h1', [text('write review')])]),
      control('plan', 'Plan write operation'),
    ]);
  if (state.phase === 'planning')
    return element('main', [
      element('header', [element('h1', [text('write review')])]),
      element('p', [text('planning')]),
    ]);
  if (state.phase === 'applying')
    return element('main', [
      element('header', [element('h1', [text('write review')])]),
      element('p', [text('Applying reviewed plan')]),
      element('section', [element('h2', [text('plan')]), ...contents(state.plan)]),
    ]);
  if (state.phase === 'done')
    return element('main', [
      element('header', [element('h1', [text('write review')])]),
      element('p', [text('Write operation complete')]),
      element('section', [
        element('h2', [text('execution result')]),
        ...contents(metadata(state.report)),
      ]),
      diagnosticsSection(state.report),
    ]);
  if (state.phase === 'stale')
    return element('main', [
      element('header', [element('h1', [text('write review')])]),
      element('p', [text('plan is stale')]),
      diagnosticsSection(state.error),
      control('retry-plan', 'Plan again'),
    ]);
  if (state.phase === 'failed')
    return element('main', [
      element('header', [element('h1', [text('write review')])]),
      element('p', [text('Write operation failed')]),
      diagnosticsSection(state.error),
      control('retry-plan', 'Plan again'),
    ]);

  const review = state;
  const permissionRows = review.required.map((item, index) =>
    element('li', [
      text(permissionText(item)),
      control('grant', 'Grant this permission', {
        control: 'checkbox',
        disabled: review.phase !== 'reviewing',
        checked: review.granted.some(
          (granted) =>
            granted.kind === item.kind &&
            granted.subject === item.subject &&
            permissionText(granted) === permissionText(item),
        ),
        itemIndex: index,
      }),
    ]),
  );
  const needsDangerConfirmation = review.required.some(
    (item) => item.kind === 'danger-full-access',
  );
  const highlighted =
    review.highlightedMissing.length > 0 ? review.highlightedMissing : review.missing;
  return element('main', [
    element('header', [
      element('h1', [text('write review')]),
      element('p', [text(`digest: ${shortDigest(review.planDigest)}`)]),
    ]),
    element('section', [element('h2', [text('plan')]), ...contents(review.plan)]),
    element('section', [
      element('h2', [text('required permissions')]),
      element('ul', permissionRows),
      ...(needsDangerConfirmation
        ? [
            control('confirm-danger-full-access', 'Confirm danger-full-access', {
              control: 'checkbox',
              disabled: review.phase !== 'reviewing',
              checked: review.dangerConfirmed,
            }),
          ]
        : []),
    ]),
    ...(highlighted.length === 0
      ? []
      : [
          element('section', [
            element('h2', [text('missing permissions')]),
            element(
              'ul',
              highlighted.map((item) => element('li', [text(permissionText(item))])),
            ),
          ]),
        ]),
    control('apply', 'Apply reviewed plan', {
      disabled: review.phase !== 'reviewing' || !canApply(review),
    }),
  ]);
}

function isBrowserState(value: unknown): value is BrowserState {
  return (
    record(value) &&
    (value.phase === 'idle' ||
      value.phase === 'planning' ||
      value.phase === 'reviewing' ||
      value.phase === 'applying' ||
      value.phase === 'done' ||
      value.phase === 'stale' ||
      value.phase === 'failed')
  );
}

/**
 * Render a serializable description tree. A DOM adapter may choose how to materialize it, but no
 * data value is ever used as a tag, attribute, control, URL, or HTML fragment here.
 */
export function renderBrowserView(
  input: BrowserViewInput | BrowserState,
  fallbackData?: unknown,
): BrowserViewNode {
  if (isBrowserState(input)) return writeReview(input);
  switch (input.kind) {
    case 'overview':
      return overview(input.data ?? fallbackData);
    case 'profile-diff':
      return profileDiff(input.data ?? fallbackData);
    case 'doctor':
      return doctor(input.data ?? input.report ?? fallbackData);
    case 'pack':
      return pack(input.data ?? fallbackData);
    case 'write-review':
      return writeReview(input.state);
  }
}

export const render = renderBrowserView;

export function textContent(node: BrowserViewNode): string {
  if (node.type === 'text') return node.text;
  return node.children.map(textContent).join('');
}
