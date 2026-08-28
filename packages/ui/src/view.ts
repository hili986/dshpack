import type { UiDangerousPermission, UiRequest, UiResponse, UiWriteRequest } from 'dshpack';

import { type Locale, type MessageKey, message } from './messages.js';
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

/**
 * Presentation is deliberately a closed set: a renderer may only select one of these static
 * class names. Pack, profile, diagnostic, and provenance data never become a CSS selector.
 */
export type BrowserViewClass =
  | 'page'
  | 'page-header'
  | 'panel'
  | 'summary-grid'
  | 'data-table'
  | 'status-badge'
  | 'status-tracked'
  | 'status-untracked'
  | 'status-reserved'
  | 'status-broken'
  | 'severity-info'
  | 'severity-warning'
  | 'severity-error'
  | 'callout'
  | 'review-status'
  | 'compose-source'
  | 'compose-skill-option'
  | 'compose-resolved';

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
  /** Every attribute is fixed presentation state; user data never becomes an attribute. */
  readonly attrs?: Readonly<{
    readonly open?: boolean;
    readonly className?: BrowserViewClass;
  }>;
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
  readonly locale?: Locale;
  /** These type-level handles intentionally stay on the shared wire contract. */
  readonly request?: UiRequest;
  readonly writeRequest?: UiWriteRequest;
  readonly report?: UiResponse;
}

type Translate = (key: MessageKey) => string;

function translator(locale: Locale): Translate {
  return (key) => message(locale, key);
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

function element(
  tag: BrowserViewTag,
  children: readonly BrowserViewNode[],
  className?: BrowserViewClass,
): BrowserElementNode {
  return {
    type: 'element',
    tag,
    children,
    ...(className === undefined ? {} : { attrs: { className } }),
  };
}

function disclosure(label: string, children: readonly BrowserViewNode[]): BrowserElementNode {
  return {
    type: 'element',
    tag: 'details',
    children: [element('summary', [text(label)]), ...children],
    attrs: { className: 'panel' },
  };
}

function dataTable(
  headers: readonly string[],
  rows: readonly (readonly BrowserViewNode[])[],
): BrowserElementNode {
  return element(
    'table',
    [
      element('thead', [
        element(
          'tr',
          headers.map((header) => element('th', [text(header)])),
        ),
      ]),
      element(
        'tbody',
        rows.map((row) =>
          element(
            'tr',
            row.map((cell) => element('td', [cell])),
          ),
        ),
      ),
    ],
    'data-table',
  );
}

function statusPresentation(
  value: unknown,
  translate: Translate,
): {
  readonly label: string;
  readonly className: BrowserViewClass;
} {
  switch (value) {
    case 'tracked':
      return { label: translate('statusTracked'), className: 'status-tracked' };
    case 'untracked':
      return { label: translate('statusUntracked'), className: 'status-untracked' };
    case 'reserved':
      return { label: translate('statusReserved'), className: 'status-reserved' };
    case 'broken':
      return { label: translate('statusBroken'), className: 'status-broken' };
    default:
      return { label: translate('statusUnknown'), className: 'status-badge' };
  }
}

function severityPresentation(
  value: unknown,
  translate: Translate,
): {
  readonly label: string;
  readonly className: BrowserViewClass;
} {
  switch (value) {
    case 'info':
      return { label: translate('severityInfo'), className: 'severity-info' };
    case 'warning':
      return { label: translate('severityWarning'), className: 'severity-warning' };
    case 'error':
      return { label: translate('severityError'), className: 'severity-error' };
    default:
      return { label: translate('statusUnknown'), className: 'status-badge' };
  }
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

function diagnosticRows(value: unknown, translate: Translate): BrowserElementNode {
  const report = record(value) ? value : {};
  const diagnostics = array(report.diagnostics).filter(record);
  return dataTable(
    [
      translate('headerCode'),
      translate('headerSeverity'),
      translate('headerMessage'),
      translate('headerLocation'),
    ],
    diagnostics.map((item) => {
      const location = formatLocation(item);
      const severity = severityPresentation(item.severity, translate);
      return [
        text(typeof item.code === 'string' ? item.code : ''),
        element('code', [text(severity.label)], severity.className),
        text(typeof item.message === 'string' ? item.message : ''),
        text(location),
      ];
    }),
  );
}

function diagnosticsSection(value: unknown, translate: Translate): BrowserElementNode {
  return element(
    'section',
    [element('h2', [text(translate('headingDiagnostics'))]), diagnosticRows(value, translate)],
    'panel',
  );
}

function overview(data: unknown, translate: Translate): BrowserViewNode {
  const source = metadata(data);
  const profiles = array(source.profiles).filter(record);
  const statuses = ['tracked', 'untracked', 'reserved', 'broken'] as const;
  const count = (status: (typeof statuses)[number]): number =>
    profiles.filter((profile) => profile.status === status).length;
  const tracked = count('tracked');
  const countRows = statuses.map((status) => {
    const presentation = statusPresentation(status, translate);
    return [
      element('code', [text(presentation.label)], presentation.className),
      text(count(status)),
    ];
  });
  const profileRows = profiles.map((profile, index) => {
    const pack = record(profile.pack) ? profile.pack : {};
    const presentation = statusPresentation(profile.status, translate);
    const isTracked = profile.status === 'tracked';
    const actions: BrowserViewNode[] = [
      control('view-profile', translate('buttonViewProfile'), { itemIndex: index }),
      control('view-diff', translate('buttonViewDiff'), { itemIndex: index }),
      ...(record(profile.packDetails)
        ? [control('view-pack', translate('buttonViewPack'), { itemIndex: index })]
        : []),
      ...(isTracked
        ? [
            control('update', translate('buttonUpdateProfile'), { itemIndex: index }),
            control('uninstall', translate('buttonUninstallProfile'), { itemIndex: index }),
            control('restore', translate('buttonRestoreProfile'), { itemIndex: index }),
          ]
        : []),
    ];
    return [
      text(typeof profile.profile === 'string' ? profile.profile : '—'),
      element('code', [text(presentation.label)], presentation.className),
      text(typeof pack.name === 'string' ? pack.name : '—'),
      text(typeof pack.version === 'string' ? pack.version : '—'),
      text(typeof profile.drift === 'number' ? profile.drift : '—'),
      text(typeof profile.sharedAssets === 'number' ? profile.sharedAssets : '—'),
      text(typeof profile.update === 'string' ? profile.update : '—'),
      text(typeof profile.generation === 'number' ? profile.generation : '—'),
      element('section', actions),
    ];
  });
  return element(
    'main',
    [
      element(
        'header',
        [
          element('h1', [text(translate('headingOverview'))]),
          element('p', [text(`${translate('trackedProfiles')}${tracked}`)]),
        ],
        'page-header',
      ),
      element(
        'section',
        [
          element('h2', [text(translate('headingStatusSummary'))]),
          dataTable([translate('headerStatus'), translate('headerCount')], countRows),
        ],
        'summary-grid',
      ),
      element(
        'section',
        [
          element('h2', [text(translate('headingProfiles'))]),
          dataTable(
            [
              translate('headerProfile'),
              translate('headerStatus'),
              translate('headerPack'),
              translate('headerVersion'),
              translate('headerDrift'),
              translate('headerSharedAssets'),
              translate('headerUpdate'),
              translate('headerGeneration'),
              translate('headerActions'),
            ],
            profileRows,
          ),
        ],
        'panel',
      ),
      control('view-doctor', translate('buttonRunDoctor')),
    ],
    'page',
  );
}

function diffItems(items: readonly unknown[], translate: Translate): BrowserElementNode {
  return dataTable(
    [
      translate('headerResource'),
      translate('headerTarget'),
      translate('headerMergeAction'),
      translate('headerCurrentDigest'),
    ],
    items.map((item) => {
      const row = record(item) ? item : {};
      return [
        text(typeof row.id === 'string' ? row.id : ''),
        text(typeof row.target === 'string' ? row.target : ''),
        text(typeof row.mergeAction === 'string' ? row.mergeAction : ''),
        text(typeof row.currentSha256 === 'string' ? shortDigest(row.currentSha256) : ''),
      ];
    }),
  );
}

function profileDiff(data: unknown, translate: Translate): BrowserViewNode {
  const source = metadata(data);
  return element(
    'main',
    [
      element(
        'header',
        [
          element('h1', [text(translate('headingProfileDiff'))]),
          element('p', [text(`${translate('planDigest')}${shortDigest(source.planDigest)}`)]),
        ],
        'page-header',
      ),
      element(
        'section',
        [
          element('h2', [text(translate('headingLocalDrift'))]),
          diffItems(array(source.localDrift), translate),
        ],
        'panel',
      ),
      element(
        'section',
        [
          element('h2', [text(translate('headingUpstreamDelta'))]),
          diffItems(array(source.upstreamDelta), translate),
        ],
        'panel',
      ),
      element(
        'section',
        [
          element('h2', [text(translate('headingEffectiveMismatch'))]),
          diffItems(array(source.effectiveMismatch), translate),
        ],
        'panel',
      ),
    ],
    'page',
  );
}

function doctor(data: unknown, translate: Translate): BrowserViewNode {
  const report = response(data);
  const source = report === undefined ? metadata(data) : report;
  const reportMetadata = report === undefined ? source : metadata(report);
  const sideEffects = array(reportMetadata.sideEffects).filter(record);
  return element(
    'main',
    [
      element('header', [element('h1', [text(translate('headingDiagnostics'))])], 'page-header'),
      diagnosticsSection(source, translate),
      element(
        'section',
        [
          element('h2', [text(translate('headingSideEffectOwnership'))]),
          dataTable(
            [translate('headerOwner'), translate('headerPath')],
            sideEffects.map((item) => [
              text(typeof item.owner === 'string' ? item.owner : ''),
              text(typeof item.path === 'string' ? item.path : ''),
            ]),
          ),
        ],
        'panel',
      ),
    ],
    'page',
  );
}

function provenanceRows(value: unknown, translate: Translate): BrowserViewNode {
  if (!Array.isArray(value)) return element('section', contents(value));
  if (value.length === 0) return element('p', [text(translate('emptyProvenance'))], 'callout');
  return dataTable(
    [
      translate('headerId'),
      translate('headerSource'),
      translate('headerOriginalId'),
      translate('headerLicense'),
    ],
    array(value).map((item) => {
      const row = record(item) ? item : {};
      return [
        text(typeof row.id === 'string' ? row.id : ''),
        text(
          typeof row.from === 'string'
            ? row.from
            : typeof row.source === 'string'
              ? row.source
              : '',
        ),
        text(typeof row.originalId === 'string' ? row.originalId : ''),
        text(typeof row.license === 'string' ? row.license : ''),
      ];
    }),
  );
}

function pack(data: unknown, translate: Translate): BrowserViewNode {
  const source = metadata(data);
  const plan = record(source.plan) ? source.plan : source;
  const manifest = plan.manifest ?? source.manifest ?? {};
  const provenance = plan.provenance ?? source.provenance ?? [];
  const lock = plan.lock ?? source.lock ?? {};
  return element(
    'main',
    [
      element('header', [element('h1', [text(translate('headingPackDetails'))])], 'page-header'),
      disclosure(translate('disclosureManifest'), contents(manifest)),
      disclosure(translate('disclosureProvenance'), [provenanceRows(provenance, translate)]),
      disclosure(translate('disclosureLock'), contents(lock)),
    ],
    'page',
  );
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

function hasDiagnosticCode(value: unknown, expected: string): boolean {
  const report = record(value) ? value : {};
  return array(report.diagnostics).some((item) => record(item) && item.code === expected);
}

function writeReview(state: BrowserState | undefined, translate: Translate): BrowserViewNode {
  if (state === undefined || state.phase === 'idle')
    return element(
      'main',
      [
        element('header', [element('h1', [text(translate('headingWriteReview'))])], 'page-header'),
        element('p', [text(translate('writeReviewGuide'))], 'callout'),
        control('plan', translate('previewWrite')),
      ],
      'page',
    );
  if (state.phase === 'planning')
    return element(
      'main',
      [
        element('header', [element('h1', [text(translate('headingWriteReview'))])], 'page-header'),
        element('p', [text(translate('planning'))], 'review-status'),
      ],
      'page',
    );
  if (state.phase === 'applying')
    return element(
      'main',
      [
        element('header', [element('h1', [text(translate('headingWriteReview'))])], 'page-header'),
        element('p', [text(translate('applying'))], 'review-status'),
        element(
          'section',
          [element('h2', [text(translate('headingPlan'))]), ...contents(state.plan)],
          'panel',
        ),
      ],
      'page',
    );
  if (state.phase === 'done')
    return element(
      'main',
      [
        element('header', [element('h1', [text(translate('headingWriteReview'))])], 'page-header'),
        element('p', [text(translate('writeCompleted'))], 'review-status'),
        element(
          'section',
          [element('h2', [text(translate('headingResult'))]), ...contents(metadata(state.report))],
          'panel',
        ),
        diagnosticsSection(state.report, translate),
      ],
      'page',
    );
  if (state.phase === 'stale')
    return element(
      'main',
      [
        element('header', [element('h1', [text(translate('headingWriteReview'))])], 'page-header'),
        element('p', [text(translate('planStale'))], 'callout'),
        diagnosticsSection(state.error, translate),
        control('retry-plan', translate('retryPlan')),
      ],
      'page',
    );
  if (state.phase === 'failed')
    return element(
      'main',
      [
        element('header', [element('h1', [text(translate('headingWriteReview'))])], 'page-header'),
        element('p', [text(translate('writeFailed'))], 'callout'),
        diagnosticsSection(state.error, translate),
        ...(state.operation === 'install' && hasDiagnosticCode(state.error, 'SOURCE_INVALID')
          ? [element('p', [text(translate('sourceInvalidGuide'))], 'callout')]
          : []),
        control('retry-plan', translate('retryPlan')),
      ],
      'page',
    );

  const review = state;
  const permissionRows = review.required.map((item, index) =>
    element('li', [
      text(permissionText(item)),
      control('grant', translate('grantPermission'), {
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
  return element(
    'main',
    [
      element(
        'header',
        [
          element('h1', [text(translate('headingWriteReview'))]),
          element('p', [text(`${translate('planDigest')}${shortDigest(review.planDigest)}`)]),
        ],
        'page-header',
      ),
      element(
        'section',
        [element('h2', [text(translate('headingPlan'))]), ...contents(review.plan)],
        'panel',
      ),
      element(
        'section',
        [
          element('h2', [text(translate('headingRequiredPermissions'))]),
          element('ul', permissionRows),
          ...(needsDangerConfirmation
            ? [
                control('confirm-danger-full-access', translate('confirmDanger'), {
                  control: 'checkbox',
                  disabled: review.phase !== 'reviewing',
                  checked: review.dangerConfirmed,
                }),
              ]
            : []),
        ],
        'panel',
      ),
      ...(highlighted.length === 0
        ? []
        : [
            element(
              'section',
              [
                element('h2', [text(translate('headingMissingPermissions'))]),
                element(
                  'ul',
                  highlighted.map((item) => element('li', [text(permissionText(item))])),
                ),
              ],
              'panel',
            ),
          ]),
      control('apply', translate('applyReviewedPlan'), {
        disabled: review.phase !== 'reviewing' || !canApply(review),
      }),
    ],
    'page',
  );
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
  if (isBrowserState(input)) return writeReview(input, translator(input.locale));
  const translate = translator(input.locale ?? input.state?.locale ?? 'zh');
  switch (input.kind) {
    case 'overview':
      return overview(input.data ?? fallbackData, translate);
    case 'profile-diff':
      return profileDiff(input.data ?? fallbackData, translate);
    case 'doctor':
      return doctor(input.data ?? input.report ?? fallbackData, translate);
    case 'pack':
      return pack(input.data ?? fallbackData, translate);
    case 'write-review':
      return writeReview(input.state, translate);
  }
}

export const render = renderBrowserView;

export function textContent(node: BrowserViewNode): string {
  if (node.type === 'text') return node.text;
  return node.children.map(textContent).join('');
}
