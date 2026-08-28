import type {
  UiComposeSpec,
  UiRequest,
  UiResponse,
  UiWriteOperation,
  UiWriteRequest,
} from 'dshpack';

import { mountBrowserView } from './dom.js';
import { type Locale, type MessageKey, message } from './messages.js';
import {
  type BrowserAction,
  type BrowserState,
  createBrowserState,
  reduceBrowserState,
} from './state.js';
import { type BrowserControlNode, renderBrowserView } from './view.js';

type ApiResult = {
  readonly status: number;
  readonly response: UiResponse;
};

type BrowserScreen =
  | 'overview'
  | 'profile-diff'
  | 'doctor'
  | 'pack'
  | 'write-review'
  | 'compose'
  | 'skill-editor';

export interface ComposeSourceForm {
  readonly from: string;
  readonly skills: readonly string[];
}

export interface ComposeSourceSkillCatalogEntry {
  readonly from: string;
  readonly skills: readonly string[];
}

interface ComposeResolutionForm {
  readonly id: string;
  readonly mode: 'prefer' | 'rename';
  readonly prefer?: string;
}

interface ComposeFocusIntent {
  readonly kind: 'profile' | 'source';
  readonly index?: number;
  readonly selectionDirection: SelectionDirection | null;
  readonly selectionEnd: number;
  readonly selectionStart: number;
}

type ComposeCompositionEnd =
  | { readonly kind: 'matched'; readonly shouldRender: boolean }
  | { readonly kind: 'mismatch' | 'none' };

type ComposeInstallDisabledReason =
  | 'notPreviewed'
  | 'stalePreview'
  | 'previewPending'
  | 'unresolvedConflicts'
  | 'unknownLicenseNotAcknowledged';

export interface ComposeInstallReadiness {
  readonly preview: UiResponse | undefined;
  readonly hasSuccessfulPreview: boolean;
  readonly previewStale: boolean;
  readonly previewPending: boolean;
  readonly resolutions: readonly ComposeResolutionForm[];
  readonly acknowledgement: boolean;
}

interface EditorSkill {
  readonly drift: boolean;
  readonly id: string;
}

export interface BrowserUiController {
  readonly refreshOverview: () => Promise<void>;
  readonly refreshDoctor: () => Promise<void>;
  readonly refreshDiff: () => Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inputEventIsComposing(event: Event): boolean {
  return (event as unknown as { readonly isComposing?: unknown }).isComposing === true;
}

function composePackName(profile: string): string {
  return profile.length >= 3 ? profile : `${profile}-ui`;
}

function composeSpec(
  profile: string,
  sources: readonly ComposeSourceForm[],
  resolutions: readonly ComposeResolutionForm[],
): UiComposeSpec {
  return {
    composeVersion: 0,
    name: composePackName(profile),
    version: '0.1.0',
    description: `Composed profile ${profile}.`,
    author: 'dshpack UI',
    license: 'MIT',
    include: sources.map((source) => ({
      from: source.from,
      skills: source.skills.length === 0 ? ['*'] : [...source.skills],
    })),
    resolve: resolutions.map((resolution) =>
      resolution.mode === 'prefer'
        ? { id: resolution.id, prefer: resolution.prefer ?? sources[0]?.from ?? '' }
        : { id: resolution.id, rename: `${resolution.id}-renamed` },
    ),
    defaults: { permissionPreset: 'workspace-write' },
  };
}

function previewMetadata(response: UiResponse | undefined): Record<string, unknown> {
  return response !== undefined && record(response.metadata) ? response.metadata : {};
}

function previewSkillCatalog(
  response: UiResponse | undefined,
  sources: readonly ComposeSourceForm[],
): readonly ComposeSourceSkillCatalogEntry[] {
  if (!isSuccessfulComposePreview(response)) return [];
  const value = previewMetadata(response).sourceSkills;
  if (!Array.isArray(value)) return [];
  const catalog = value.flatMap((source) => {
    if (
      !record(source) ||
      typeof source.from !== 'string' ||
      !Array.isArray(source.skills) ||
      !source.skills.every((skill) => typeof skill === 'string')
    )
      return [];
    return [{ from: source.from, skills: source.skills }];
  });
  if (catalog.length !== value.length || sources.some((source) => source.from.length === 0))
    return [];
  const sourceCounts = new Map<string, number>();
  for (const source of sources)
    sourceCounts.set(source.from, (sourceCounts.get(source.from) ?? 0) + 1);
  const catalogCounts = new Map<string, number>();
  for (const entry of catalog)
    catalogCounts.set(entry.from, (catalogCounts.get(entry.from) ?? 0) + 1);
  return sourceCounts.size === catalogCounts.size &&
    [...sourceCounts].every(([from, count]) => catalogCounts.get(from) === count)
    ? catalog
    : [];
}

function catalogSkillsForSource(
  catalog: readonly ComposeSourceSkillCatalogEntry[],
  source: ComposeSourceForm,
): readonly string[] | undefined {
  return catalog.find((entry) => entry.from === source.from)?.skills;
}

function selectedCatalogSkillsForSource(
  source: ComposeSourceForm,
  catalog: readonly ComposeSourceSkillCatalogEntry[],
): ReadonlySet<string> {
  const availableSkills = catalogSkillsForSource(catalog, source);
  return new Set(source.skills.filter((id) => availableSkills?.includes(id) === true));
}

function previewConflictIds(response: UiResponse | undefined): readonly string[] {
  const value = previewMetadata(response).conflicts;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    record(item) && typeof item.path === 'string' ? [item.path] : [],
  );
}

export function selectedComposeSkillConflictIds(
  sources: readonly ComposeSourceForm[],
  catalog: readonly ComposeSourceSkillCatalogEntry[],
): readonly string[] {
  const selectedBySource = new Map<string, Set<string>>();
  for (const source of sources) {
    const selected = selectedCatalogSkillsForSource(source, catalog);
    const selectedForSource = selectedBySource.get(source.from) ?? new Set<string>();
    for (const id of selected) selectedForSource.add(id);
    selectedBySource.set(source.from, selectedForSource);
  }
  const counts = new Map<string, number>();
  for (const selected of selectedBySource.values())
    for (const id of selected) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count >= 2)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function clientConflictParticipantSources(
  id: string,
  sources: readonly ComposeSourceForm[],
  catalog: readonly ComposeSourceSkillCatalogEntry[],
): readonly string[] {
  const participants = new Set<string>();
  for (const source of sources)
    if (selectedCatalogSkillsForSource(source, catalog).has(id)) participants.add(source.from);
  return [...participants];
}

function validComposeResolutions(
  resolutions: readonly ComposeResolutionForm[],
  sources: readonly ComposeSourceForm[],
  catalog: readonly ComposeSourceSkillCatalogEntry[],
): readonly ComposeResolutionForm[] {
  const conflictIds = new Set(selectedComposeSkillConflictIds(sources, catalog));
  return resolutions.flatMap((resolution) => {
    if (!conflictIds.has(resolution.id)) return [];
    if (resolution.mode === 'rename') return [resolution];
    const participants = clientConflictParticipantSources(resolution.id, sources, catalog);
    const prefer = participants.includes(resolution.prefer ?? '')
      ? resolution.prefer
      : participants[0];
    return prefer === undefined ? [] : [{ ...resolution, prefer }];
  });
}

function previewResolvedSources(response: UiResponse | undefined): readonly string[] {
  const selected = previewMetadata(response).selected;
  if (!Array.isArray(selected)) return [];
  return [
    ...new Set(
      selected.flatMap((item) =>
        record(item) && typeof item.from === 'string' ? [item.from] : [],
      ),
    ),
  ];
}

interface ComposeDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
}

function previewDiagnostics(response: UiResponse | undefined): readonly ComposeDiagnostic[] {
  return (response?.diagnostics ?? []).flatMap((item) => {
    if (!record(item) || typeof item.code !== 'string' || typeof item.message !== 'string')
      return [];
    switch (item.severity) {
      case 'error':
      case 'warning':
      case 'info':
        return [{ code: item.code, message: item.message, severity: item.severity }];
      default:
        return [];
    }
  });
}

function isSuccessfulComposePreview(response: UiResponse | undefined): boolean {
  return response?.exitCode === 0 && previewMetadata(response).phase === 'preview';
}

function previewRequiresUnknownLicenseAcknowledgement(response: UiResponse | undefined): boolean {
  return (
    isSuccessfulComposePreview(response) &&
    previewDiagnostics(response).some((item) => item.code === 'W_COMPOSE_UNKNOWN_LICENSE')
  );
}

export function composeInstallDisabledReasons(
  readiness: ComposeInstallReadiness,
): readonly ComposeInstallDisabledReason[] {
  if (readiness.previewPending) return ['previewPending'];
  if (readiness.previewStale) return ['stalePreview'];
  if (!readiness.hasSuccessfulPreview || !isSuccessfulComposePreview(readiness.preview))
    return ['notPreviewed'];
  const reasons: ComposeInstallDisabledReason[] = [];
  if (
    previewConflictIds(readiness.preview).some(
      (id) => !readiness.resolutions.some((resolution) => resolution.id === id),
    )
  )
    reasons.push('unresolvedConflicts');
  if (previewRequiresUnknownLicenseAcknowledgement(readiness.preview) && !readiness.acknowledgement)
    reasons.push('unknownLicenseNotAcknowledged');
  return reasons;
}

function composeInstallDisabledReasonMessage(reason: ComposeInstallDisabledReason): MessageKey {
  switch (reason) {
    case 'notPreviewed':
      return 'composeInstallNotPreviewed';
    case 'stalePreview':
      return 'composeInstallStale';
    case 'previewPending':
      return 'composeInstallPending';
    case 'unresolvedConflicts':
      return 'composeInstallUnresolvedConflicts';
    case 'unknownLicenseNotAcknowledged':
      return 'composeInstallUnknownLicense';
  }
}

function archiveEntryDiagnostics(
  diagnostics: readonly ComposeDiagnostic[],
): readonly ComposeDiagnostic[] {
  return diagnostics.filter((item) => item.code === 'E_ARCHIVE_ENTRY_SKIPPED');
}

function diagnosticFeedbackClass(item: ComposeDiagnostic): string {
  return item.severity === 'error'
    ? 'compose-feedback compose-feedback-error'
    : item.severity === 'warning'
      ? 'compose-feedback compose-feedback-warning'
      : 'compose-feedback compose-feedback-info';
}

function resolvedSourceDisplay(from: string): string {
  return from.replace(/#([0-9a-f]{40})$/iu, (_match, sha: string) => `#${sha.slice(0, 7)}`);
}

function editorSkillsFromDiff(value: unknown): readonly EditorSkill[] {
  if (!record(value)) return [];
  const drift = new Set(
    (Array.isArray(value.localDrift) ? value.localDrift : []).flatMap((item) =>
      record(item) && item.kind === 'skill' && typeof item.target === 'string'
        ? [item.target.replace(/^skills\//u, '')]
        : [],
    ),
  );
  const ids = new Set(
    (Array.isArray(value.assetDigests) ? value.assetDigests : []).flatMap((item) =>
      record(item) && typeof item.target === 'string' && item.target.startsWith('skills/')
        ? [item.target.slice('skills/'.length)]
        : [],
    ),
  );
  for (const id of drift) ids.add(id);
  return [...ids]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((id) => ({ id, drift: drift.has(id) }));
}

function safeProfile(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value) && value.length >= 1 && value.length <= 64;
}

function safeSkillId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function failureResponse(locale: Locale, code: string, messageKey: MessageKey): UiResponse {
  return {
    diagnostics: [
      { code, severity: 'error', message: message(locale, messageKey), evidence: 'local' },
    ],
    exitCode: 1 as UiResponse['exitCode'],
    metadata: {},
  };
}

function responseFrom(value: unknown, locale: Locale): UiResponse {
  if (
    record(value) &&
    Array.isArray(value.diagnostics) &&
    typeof value.exitCode === 'number' &&
    record(value.metadata)
  )
    return value as unknown as UiResponse;
  return failureResponse(locale, 'E_UI_RESPONSE', 'responseInvalid');
}

async function postApi(
  token: string | null,
  request: UiRequest,
  locale: Locale,
): Promise<ApiResult> {
  if (token === null || token.length === 0)
    return { status: 401, response: failureResponse(locale, 'E_UI_TOKEN', 'tokenMissing') };

  try {
    const response = await fetch('/api', {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });
    const body: unknown = await response.json().catch(() => undefined);
    return { status: response.status, response: responseFrom(body, locale) };
  } catch {
    return {
      status: 0,
      response: failureResponse(locale, 'E_UI_NETWORK', 'networkUnavailable'),
    };
  }
}

function freshPlanRequest(
  operation: UiWriteOperation,
  input: UiWriteRequest['input'],
): UiWriteRequest {
  return {
    operation,
    phase: 'plan',
    input,
    authorizedDangerousPermissions: [],
  } as UiWriteRequest;
}

function writeOperation(value: string): UiWriteOperation | undefined {
  switch (value) {
    case 'install':
    case 'uninstall':
    case 'update':
    case 'restore':
    case 'gc':
      return value;
    default:
      return undefined;
  }
}

function operationLabel(operation: UiWriteOperation, locale: Locale): string {
  switch (operation) {
    case 'install':
      return message(locale, 'operationInstall');
    case 'uninstall':
      return message(locale, 'operationUninstall');
    case 'update':
      return message(locale, 'operationUpdate');
    case 'restore':
      return message(locale, 'operationRestore');
    case 'gc':
      return message(locale, 'operationGc');
    case 'compose':
      return message(locale, 'composeInstall');
    case 'editSkill':
      return message(locale, 'editorSave');
  }
}

function targetCopy(
  locale: Locale,
  operation: UiWriteOperation | undefined,
): {
  readonly label: string;
  readonly placeholder: string;
  readonly disabled: boolean;
} {
  if (operation === 'install')
    return {
      label: message(locale, 'targetInstallSource'),
      placeholder: message(locale, 'placeholderInstallSource'),
      disabled: false,
    };
  if (operation === 'gc')
    return {
      label: message(locale, 'targetNoInput'),
      placeholder: message(locale, 'placeholderNoInput'),
      disabled: true,
    };
  return {
    label: message(locale, 'targetProfile'),
    placeholder: message(locale, 'placeholderProfile'),
    disabled: false,
  };
}

function diffTargetCopy(locale: Locale): {
  readonly label: string;
  readonly placeholder: string;
  readonly disabled: boolean;
} {
  return {
    label: message(locale, 'targetDiffProfile'),
    placeholder: message(locale, 'placeholderDiffProfile'),
    disabled: false,
  };
}

function installSourceLooksLikeSource(value: string): boolean {
  return (
    value.startsWith('github:') ||
    value.startsWith('tarball:') ||
    /^https:\/\/github\.com\//iu.test(value) ||
    /^(?:[A-Za-z]:[\\/]|[./][\\/]|\\\\|\/)/u.test(value)
  );
}

function formValidationMessage(
  operation: UiWriteOperation | undefined,
  target: string,
): MessageKey | undefined {
  if (operation === undefined) return 'validationInvalidOperation';
  if (operation === 'gc') return undefined;
  if (target.length === 0)
    return operation === 'install' ? 'validationMissingInstallSource' : 'validationMissingProfile';
  if (operation === 'install' && !installSourceLooksLikeSource(target))
    return 'validationInstallSourceShape';
  return undefined;
}

function requestFromForm(operation: UiWriteOperation, target: string): UiWriteRequest | undefined {
  if (operation === 'gc') return freshPlanRequest(operation, {});
  if (target.length === 0) return undefined;

  switch (operation) {
    case 'install':
      return freshPlanRequest(operation, { source: target });
    case 'uninstall':
      return freshPlanRequest(operation, { profile: target });
    case 'update':
      return freshPlanRequest(operation, { profile: target });
    case 'restore':
      return freshPlanRequest(operation, { profile: target });
  }
}

function operationOptions(document: Document, select: HTMLSelectElement, locale: Locale): void {
  const operations: readonly UiWriteOperation[] = [
    'install',
    'uninstall',
    'update',
    'restore',
    'gc',
  ];
  for (const operation of operations) {
    const option = document.createElement('option');
    option.value = operation;
    option.textContent = operationLabel(operation, locale);
    select.append(option);
  }
}

function screenFromHash(hash: string): BrowserScreen {
  switch (hash.replace(/^#/u, '')) {
    case 'overview':
      return 'overview';
    case 'profile-diff':
      return 'profile-diff';
    case 'doctor':
      return 'doctor';
    case 'pack':
      return 'pack';
    case 'write-review':
      return 'write-review';
    case 'compose':
      return 'compose';
    case 'skill-editor':
      return 'skill-editor';
    default:
      return 'overview';
  }
}

function navigationButton(
  document: Document,
  screen: BrowserScreen,
  locale: Locale,
  select: (screen: BrowserScreen) => void,
): HTMLButtonElement {
  const labels: Readonly<Record<BrowserScreen, string>> = {
    overview: message(locale, 'navOverview'),
    'profile-diff': message(locale, 'navProfileDiff'),
    doctor: message(locale, 'navDoctor'),
    pack: message(locale, 'navPack'),
    'write-review': message(locale, 'navWriteReview'),
    compose: message(locale, 'navCompose'),
    'skill-editor': message(locale, 'navSkillEditor'),
  };
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = labels[screen];
  button.addEventListener('click', () => select(screen));
  return button;
}

/**
 * Start the no-framework browser UI. The capability token stays only in this invocation's closure.
 */
export function startBrowserUi(root: HTMLElement): BrowserUiController {
  const document = root.ownerDocument;
  const token = new URL(window.location.href).searchParams.get('token');
  let state: BrowserState = createBrowserState();
  let activeScreen: BrowserScreen = screenFromHash(window.location.hash);
  let overviewData: unknown;
  let diffData: unknown;
  let doctorData: unknown;
  let packData: unknown;
  let composeSources: readonly ComposeSourceForm[] = [{ from: '', skills: [] }];
  let composeProfile = '';
  let composePreview: UiResponse | undefined;
  let composeSkillCatalog: readonly ComposeSourceSkillCatalogEntry[] = [];
  let composeHasSuccessfulPreview = false;
  let composePreviewStale = false;
  let composePreviewRevision = 0;
  let composePreviewRequest = 0;
  let composePreviewPending = false;
  let composeResolutions: readonly ComposeResolutionForm[] = [];
  let composeAcknowledgement = false;
  let composeFocus: ComposeFocusIntent | undefined;
  let composeComposition: HTMLInputElement | undefined;
  let composeRenderDeferred = false;
  let composeValidation: MessageKey | undefined;
  let composeValidationFeedback: readonly HTMLParagraphElement[] = [];
  let composeInstallButton: HTMLButtonElement | undefined;
  let editorProfile = '';
  let editorSkills: readonly EditorSkill[] = [];
  let editorSkillId = '';
  let editorContent = '';
  let editorPending: 'skills' | 'content' | undefined;

  root.textContent = '';
  const controls = document.createElement('section');
  const controlsHeading = document.createElement('h1');
  const operationLabel = document.createElement('label');
  const operationSelect = document.createElement('select');
  const targetLabel = document.createElement('label');
  const target = document.createElement('input');
  const planButton = document.createElement('button');
  const resetButton = document.createElement('button');
  const diffButton = document.createElement('button');
  const chineseButton = document.createElement('button');
  const englishButton = document.createElement('button');
  // Kept in one compact container: as bare grid children the second button lands in the
  // stretch column and the pair renders mismatched (user-reported).
  const localeSwitch = document.createElement('div');
  localeSwitch.className = 'locale-switch';
  const navigation = document.createElement('nav');
  const notice = document.createElement('p');
  const activeMount = document.createElement('section');
  let clientMessageKey: MessageKey | undefined;

  target.type = 'text';
  planButton.type = 'button';
  resetButton.type = 'button';
  diffButton.type = 'button';
  chineseButton.type = 'button';
  englishButton.type = 'button';

  function refreshTargetCopy(): void {
    const operation = writeOperation(operationSelect.value);
    const copy =
      activeScreen === 'profile-diff'
        ? diffTargetCopy(state.locale)
        : targetCopy(state.locale, operation);
    targetLabel.textContent = copy.label;
    target.placeholder = copy.placeholder;
    target.disabled = copy.disabled;
    planButton.disabled = activeScreen === 'profile-diff';
    diffButton.disabled = activeScreen !== 'profile-diff';
    if (copy.disabled) target.value = '';
    targetLabel.append(target);
  }

  function renderControls(): void {
    const selectedOperation = operationSelect.value;
    controlsHeading.textContent = message(state.locale, 'appTitle');
    chineseButton.textContent = message(state.locale, 'localeChinese');
    englishButton.textContent = message(state.locale, 'localeEnglish');
    operationLabel.textContent = message(state.locale, 'operation');
    operationSelect.textContent = '';
    operationOptions(document, operationSelect, state.locale);
    if (selectedOperation.length > 0) operationSelect.value = selectedOperation;
    operationLabel.append(operationSelect);
    planButton.textContent = message(state.locale, 'previewPlan');
    resetButton.textContent = message(state.locale, 'resetReview');
    diffButton.textContent = message(state.locale, 'loadDiff');
    navigation.textContent = '';
    for (const screen of [
      'overview',
      'profile-diff',
      'doctor',
      'pack',
      'compose',
      'skill-editor',
      'write-review',
    ] as const)
      navigation.append(navigationButton(document, screen, state.locale, selectScreen));
    refreshTargetCopy();
    if (clientMessageKey !== undefined)
      notice.textContent = message(state.locale, clientMessageKey);
  }

  localeSwitch.append(chineseButton, englishButton);
  controls.append(
    controlsHeading,
    localeSwitch,
    operationLabel,
    targetLabel,
    planButton,
    diffButton,
    resetButton,
    navigation,
    notice,
  );
  root.append(controls, activeMount);
  renderControls();

  function setMessage(value: string): void {
    clientMessageKey = undefined;
    notice.textContent = value;
  }

  function setMessageKey(key: MessageKey): void {
    clientMessageKey = key;
    notice.textContent = message(state.locale, key);
  }

  function requestFromCurrentForm(): UiWriteRequest | undefined {
    const operation = writeOperation(operationSelect.value);
    const targetValue = target.value.trim();
    const validationMessageKey = formValidationMessage(operation, targetValue);
    if (validationMessageKey !== undefined) {
      setMessageKey(validationMessageKey);
      return undefined;
    }
    // A corrected field must not leave a prior client-side validation error visible while its
    // request is being reviewed or while the server reports the actual result.
    setMessage('');
    return operation === undefined ? undefined : requestFromForm(operation, targetValue);
  }

  function renderIfActive(screen: BrowserScreen): void {
    if (activeScreen !== screen) return;
    if (screen === 'compose' && composeComposition !== undefined) {
      composeRenderDeferred = true;
      return;
    }
    renderActiveScreen();
  }

  function composeFocusIntent(
    kind: ComposeFocusIntent['kind'],
    input: HTMLInputElement,
    index?: number,
  ): ComposeFocusIntent {
    return {
      kind,
      ...(index === undefined ? {} : { index }),
      selectionDirection: input.selectionDirection,
      selectionEnd: input.selectionEnd ?? input.value.length,
      selectionStart: input.selectionStart ?? input.value.length,
    };
  }

  function rerenderComposeWithFocus(intent: ComposeFocusIntent): void {
    composeFocus = intent;
    renderIfActive('compose');
  }

  function composeProfileUpdate(input: HTMLInputElement): boolean {
    const profile = input.value.trim();
    if (profile === composeProfile) return false;
    const focus = composeFocusIntent('profile', input);
    composeProfile = profile;
    clearComposeValidation();
    invalidateComposePreview();
    rerenderComposeWithFocus(focus);
    return true;
  }

  function composeSourceInputUpdate(index: number, input: HTMLInputElement): boolean {
    const source = composeSources[index];
    if (source === undefined) return false;
    const from = input.value.trim();
    if (from === source.from) return false;
    composeSourceUpdate(
      index,
      { from, skills: [] },
      true,
      composeFocusIntent('source', input, index),
    );
    return true;
  }

  function beginComposeComposition(input: HTMLInputElement): void {
    composeComposition = input;
  }

  function endComposeComposition(input: HTMLInputElement): ComposeCompositionEnd {
    if (composeComposition === undefined) return { kind: 'none' };
    if (composeComposition !== input) return { kind: 'mismatch' };
    composeComposition = undefined;
    const shouldRender = composeRenderDeferred;
    composeRenderDeferred = false;
    return { kind: 'matched', shouldRender };
  }

  function composeSourceUpdate(
    index: number,
    source: ComposeSourceForm,
    clearSkillCatalog = false,
    focus?: ComposeFocusIntent,
  ): void {
    composeSources = composeSources.map((current, currentIndex) =>
      currentIndex === index ? source : current,
    );
    composeResolutions = [];
    clearComposeValidation();
    invalidateComposePreview(clearSkillCatalog);
    if (focus !== undefined) rerenderComposeWithFocus(focus);
    else renderIfActive('compose');
  }

  function clearComposeValidation(): void {
    composeValidation = undefined;
    for (const feedback of composeValidationFeedback) {
      feedback.className = 'compose-feedback';
      feedback.textContent = '';
    }
  }

  function invalidateComposePreview(clearSkillCatalog = false): void {
    composePreviewRevision += 1;
    composePreview = undefined;
    composePreviewStale = composeHasSuccessfulPreview;
    composeAcknowledgement = false;
    if (clearSkillCatalog) composeSkillCatalog = [];
    if (composeInstallButton !== undefined) composeInstallButton.disabled = true;
  }

  function composeResolutionUpdate(resolutions: readonly ComposeResolutionForm[]): void {
    composeResolutions = resolutions;
    clearComposeValidation();
    invalidateComposePreview();
    renderIfActive('compose');
  }

  function composeInstallReady(): boolean {
    return (
      composeInstallDisabledReasons({
        preview: composePreview,
        hasSuccessfulPreview: composeHasSuccessfulPreview,
        previewStale: composePreviewStale,
        previewPending: composePreviewPending,
        resolutions: composeResolutions,
        acknowledgement: composeAcknowledgement,
      }).length === 0
    );
  }

  function renderComposeScreen(): void {
    if (composeComposition !== undefined) {
      composeRenderDeferred = true;
      return;
    }
    activeMount.textContent = '';
    composeValidationFeedback = [];
    const focusIntent = composeFocus;
    composeFocus = undefined;
    let focusTarget: HTMLInputElement | undefined;
    const panel = document.createElement('section');
    const heading = document.createElement('h2');
    const profileLabel = document.createElement('label');
    const profile = document.createElement('input');
    const preview = document.createElement('button');
    const install = document.createElement('button');
    const addSource = document.createElement('button');
    const sources = document.createElement('section');
    const resolvedSources = document.createElement('section');
    const conflicts = document.createElement('section');

    const validationFeedback = (key: MessageKey): HTMLParagraphElement => {
      const feedback = document.createElement('p');
      feedback.className = 'compose-feedback compose-feedback-error';
      feedback.textContent = message(state.locale, key);
      composeValidationFeedback = [...composeValidationFeedback, feedback];
      return feedback;
    };

    heading.textContent = message(state.locale, 'composeHeading');
    profileLabel.textContent = message(state.locale, 'composeProfile');
    profile.type = 'text';
    profile.placeholder = 'my-research-kit';
    profile.value = composeProfile;
    profile.addEventListener('compositionstart', (event) => {
      const current = event.currentTarget;
      if (current instanceof HTMLInputElement) beginComposeComposition(current);
    });
    profile.addEventListener('input', (event) => {
      const current = event.currentTarget;
      if (inputEventIsComposing(event)) {
        if (current instanceof HTMLInputElement) beginComposeComposition(current);
        return;
      }
      if (current instanceof HTMLInputElement) composeProfileUpdate(current);
    });
    profile.addEventListener('compositionend', (event) => {
      const current = event.currentTarget;
      if (!(current instanceof HTMLInputElement)) return;
      const compositionEnd = endComposeComposition(current);
      if (compositionEnd.kind !== 'matched') return;
      if (!composeProfileUpdate(current) && compositionEnd.shouldRender) renderIfActive('compose');
    });
    profileLabel.append(profile);
    if (focusIntent?.kind === 'profile') focusTarget = profile;
    const profileFeedback =
      composeValidation === 'validationComposeProfile'
        ? validationFeedback(composeValidation)
        : undefined;

    for (const [index, source] of composeSources.entries()) {
      const card = document.createElement('section');
      const sourceLabel = document.createElement('label');
      const sourceInput = document.createElement('input');
      const remove = document.createElement('button');
      const skillsHeading = document.createElement('h3');
      const catalogSkills = catalogSkillsForSource(composeSkillCatalog, source);
      const skills = catalogSkills ?? [];
      card.className = 'compose-source';
      sourceInput.type = 'text';
      sourceInput.placeholder = message(state.locale, 'placeholderComposeSource');
      sourceInput.value = source.from;
      sourceLabel.textContent = `${message(state.locale, 'composeSource')} ${String(index + 1)}`;
      sourceInput.addEventListener('compositionstart', (event) => {
        const current = event.currentTarget;
        if (current instanceof HTMLInputElement) beginComposeComposition(current);
      });
      sourceInput.addEventListener('input', (event) => {
        const current = event.currentTarget;
        if (inputEventIsComposing(event)) {
          if (current instanceof HTMLInputElement) beginComposeComposition(current);
          return;
        }
        if (current instanceof HTMLInputElement) composeSourceInputUpdate(index, current);
      });
      sourceInput.addEventListener('compositionend', (event) => {
        const current = event.currentTarget;
        if (!(current instanceof HTMLInputElement)) return;
        const compositionEnd = endComposeComposition(current);
        if (compositionEnd.kind !== 'matched') return;
        if (!composeSourceInputUpdate(index, current) && compositionEnd.shouldRender)
          renderIfActive('compose');
      });
      sourceLabel.append(sourceInput);
      if (focusIntent?.kind === 'source' && focusIntent.index === index) focusTarget = sourceInput;
      remove.type = 'button';
      remove.textContent = message(state.locale, 'composeRemoveSource');
      remove.disabled = composeSources.length === 1;
      remove.addEventListener('click', () => {
        composeSources = composeSources.filter((_, currentIndex) => currentIndex !== index);
        composeResolutions = [];
        clearComposeValidation();
        invalidateComposePreview(true);
        renderComposeScreen();
      });
      skillsHeading.textContent = message(state.locale, 'composeSourceSkills');
      card.append(sourceLabel);
      if (composeValidation === 'validationComposeSource' && source.from.length === 0)
        card.append(validationFeedback(composeValidation));
      card.append(remove);
      if (skills.length > 0) card.append(skillsHeading);
      for (const skill of skills) {
        const skillLabel = document.createElement('label');
        const checked = document.createElement('input');
        const skillText = document.createElement('span');
        checked.type = 'checkbox';
        checked.checked = source.skills.includes(skill);
        checked.addEventListener('change', (event) => {
          const current = event.currentTarget;
          if (!(current instanceof HTMLInputElement)) return;
          const skills = current.checked
            ? [...new Set([...source.skills, skill])]
            : source.skills.filter((id) => id !== skill);
          composeSourceUpdate(index, { ...source, skills });
        });
        skillText.textContent = skill;
        skillLabel.className = 'compose-skill-option';
        skillLabel.append(checked, skillText);
        card.append(skillLabel);
      }
      if (catalogSkills !== undefined && skills.length === 0) {
        const noSkills = document.createElement('p');
        noSkills.className = 'compose-feedback compose-feedback-info';
        noSkills.textContent = message(state.locale, 'composeNoSkills');
        card.append(noSkills);
      }
      sources.append(card);
    }

    for (const from of previewResolvedSources(composePreview)) {
      const resolved = document.createElement('p');
      resolved.className = 'compose-resolved';
      resolved.title = from;
      resolved.textContent = resolvedSourceDisplay(from);
      resolvedSources.append(resolved);
    }

    addSource.type = 'button';
    addSource.textContent = message(state.locale, 'composeAddSource');
    addSource.addEventListener('click', () => {
      composeSources = [...composeSources, { from: '', skills: [] }];
      composeResolutions = [];
      clearComposeValidation();
      invalidateComposePreview(true);
      renderComposeScreen();
    });

    if (previewRequiresUnknownLicenseAcknowledgement(composePreview)) {
      const acknowledgement = document.createElement('label');
      const checked = document.createElement('input');
      const text = document.createElement('span');
      checked.type = 'checkbox';
      checked.checked = composeAcknowledgement;
      checked.addEventListener('change', (event) => {
        const current = event.currentTarget;
        if (!(current instanceof HTMLInputElement)) return;
        composeAcknowledgement = current.checked;
        renderIfActive('compose');
      });
      text.textContent = message(state.locale, 'composeUnknownLicenseAcknowledgement');
      acknowledgement.className = 'compose-skill-option';
      acknowledgement.append(checked, text);
      conflicts.append(acknowledgement);
    }

    const clientConflictIds = selectedComposeSkillConflictIds(composeSources, composeSkillCatalog);
    if (clientConflictIds.length > 0) {
      const heading = document.createElement('p');
      const hint = document.createElement('p');
      heading.textContent = message(state.locale, 'composeConflicts');
      hint.className = 'compose-feedback compose-feedback-info';
      hint.textContent = message(state.locale, 'composeClientConflictHint');
      conflicts.append(heading, hint);
    }
    for (const id of clientConflictIds) {
      const card = document.createElement('section');
      const label = document.createElement('p');
      const prefer = document.createElement('input');
      const rename = document.createElement('input');
      const sourceSelect = document.createElement('select');
      const sourceLabel = document.createElement('label');
      const preferText = document.createElement('span');
      const renameText = document.createElement('span');
      const resolution = composeResolutions.find((item) => item.id === id);
      const participants = clientConflictParticipantSources(
        id,
        composeSources,
        composeSkillCatalog,
      );
      const preferredSource = participants.includes(resolution?.prefer ?? '')
        ? resolution?.prefer
        : participants[0];
      label.textContent = id;
      prefer.type = 'radio';
      prefer.checked = resolution?.mode === 'prefer';
      prefer.addEventListener('change', () => {
        composeResolutionUpdate([
          ...composeResolutions.filter((item) => item.id !== id),
          { id, mode: 'prefer', prefer: preferredSource ?? '' },
        ]);
      });
      rename.type = 'radio';
      rename.checked = resolution?.mode === 'rename';
      rename.addEventListener('change', () => {
        composeResolutionUpdate([
          ...composeResolutions.filter((item) => item.id !== id),
          { id, mode: 'rename' },
        ]);
      });
      preferText.textContent = message(state.locale, 'composeResolvePrefer');
      renameText.textContent = message(state.locale, 'composeResolveRename');
      sourceLabel.textContent = message(state.locale, 'composePreferSource');
      for (const from of participants) {
        const option = document.createElement('option');
        option.value = from;
        option.textContent = from;
        option.selected = from === preferredSource;
        sourceSelect.append(option);
      }
      sourceSelect.disabled = resolution?.mode !== 'prefer';
      sourceSelect.addEventListener('change', () => {
        composeResolutionUpdate([
          ...composeResolutions.filter((item) => item.id !== id),
          { id, mode: 'prefer', prefer: sourceSelect.value },
        ]);
      });
      card.append(label, prefer, preferText, rename, renameText);
      card.append(sourceLabel, sourceSelect);
      conflicts.append(card);
    }

    preview.type = 'button';
    preview.textContent = message(state.locale, 'composePreview');
    preview.disabled = composePreviewPending;
    preview.addEventListener('click', () => void requestComposePreview());
    const pendingFeedback = document.createElement('p');
    if (composePreviewPending) {
      pendingFeedback.className = 'compose-feedback compose-feedback-info';
      pendingFeedback.textContent = message(state.locale, 'composePreviewPending');
    }
    const disabledReasons = composeInstallDisabledReasons({
      preview: composePreview,
      hasSuccessfulPreview: composeHasSuccessfulPreview,
      previewStale: composePreviewStale,
      previewPending: composePreviewPending,
      resolutions: composeResolutions,
      acknowledgement: composeAcknowledgement,
    });
    const disabledFeedback = disabledReasons.map((reason) => {
      const feedback = document.createElement('p');
      feedback.className = 'compose-feedback compose-feedback-info';
      feedback.textContent = message(state.locale, composeInstallDisabledReasonMessage(reason));
      return feedback;
    });
    install.type = 'button';
    install.textContent = message(state.locale, 'composeInstall');
    install.disabled = disabledReasons.length > 0;
    composeInstallButton = install;
    install.addEventListener('click', () => {
      if (install.disabled || !composeInstallReady()) {
        setMessageKey('composePreviewRequired');
        return;
      }
      void submitPlan(
        freshPlanRequest('compose', {
          profile: composeProfile,
          spec: composeSpec(composeProfile, composeSources, composeResolutions),
          ...(composeAcknowledgement ? { allowUnknownLicense: true } : {}),
        }),
      );
    });
    const diagnostics = document.createElement('section');
    const previewedDiagnostics = previewDiagnostics(composePreview);
    const skippedEntries = archiveEntryDiagnostics(previewedDiagnostics);
    if (skippedEntries.length > 0) {
      const grouped = document.createElement('details');
      const summary = document.createElement('summary');
      const code = document.createElement('code');
      const paths = document.createElement('ul');
      const severity = skippedEntries.some((item) => item.severity === 'error')
        ? 'error'
        : skippedEntries.some((item) => item.severity === 'warning')
          ? 'warning'
          : 'info';
      grouped.className = diagnosticFeedbackClass({
        code: 'E_ARCHIVE_ENTRY_SKIPPED',
        message: '',
        severity,
      });
      summary.textContent = `${message(state.locale, 'composeArchiveEntriesSkipped').replace(
        '{count}',
        String(skippedEntries.length),
      )} `;
      code.title = message(state.locale, 'composeDiagnosticCode');
      code.textContent = 'E_ARCHIVE_ENTRY_SKIPPED';
      summary.append(code);
      for (const item of skippedEntries) {
        const path = document.createElement('li');
        path.textContent = item.message;
        paths.append(path);
      }
      grouped.append(summary, paths);
      diagnostics.append(grouped);
    }
    for (const item of previewedDiagnostics) {
      if (item.code === 'E_ARCHIVE_ENTRY_SKIPPED') continue;
      const feedback = document.createElement('p');
      const code = document.createElement('code');
      feedback.className = diagnosticFeedbackClass(item);
      feedback.textContent = `${item.message} `;
      code.title = message(state.locale, 'composeDiagnosticCode');
      code.textContent = item.code;
      feedback.append(code);
      diagnostics.append(feedback);
    }
    panel.append(
      heading,
      profileLabel,
      ...(profileFeedback === undefined ? [] : [profileFeedback]),
      sources,
      resolvedSources,
      addSource,
      conflicts,
      preview,
      ...(composePreviewPending ? [pendingFeedback] : []),
      diagnostics,
      ...disabledFeedback,
      install,
    );
    activeMount.append(panel);
    if (focusIntent !== undefined && focusTarget !== undefined) {
      if (typeof focusTarget.focus === 'function') focusTarget.focus();
      if (typeof focusTarget.setSelectionRange === 'function') {
        const selectionStart = Math.min(focusIntent.selectionStart, focusTarget.value.length);
        const selectionEnd = Math.min(
          Math.max(selectionStart, focusIntent.selectionEnd),
          focusTarget.value.length,
        );
        if (focusIntent.selectionDirection === null)
          focusTarget.setSelectionRange(selectionStart, selectionEnd);
        else
          focusTarget.setSelectionRange(
            selectionStart,
            selectionEnd,
            focusIntent.selectionDirection,
          );
      }
    }
  }

  function trackedProfiles(): readonly string[] {
    if (!record(overviewData) || !Array.isArray(overviewData.profiles)) return [];
    return overviewData.profiles.flatMap((item) =>
      record(item) && item.status === 'tracked' && typeof item.profile === 'string'
        ? [item.profile]
        : [],
    );
  }

  function renderSkillEditor(): void {
    activeMount.textContent = '';
    const panel = document.createElement('section');
    const heading = document.createElement('h2');
    const profileLabel = document.createElement('label');
    const profile = document.createElement('select');
    const skills = document.createElement('section');
    const skillLabel = document.createElement('label');
    const skill = document.createElement('input');
    const load = document.createElement('button');
    const contentLabel = document.createElement('label');
    const editor = document.createElement('textarea');
    const save = document.createElement('button');

    heading.textContent = message(state.locale, 'editorHeading');
    profileLabel.textContent = message(state.locale, 'editorProfile');
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = message(state.locale, 'editorProfile');
    profile.append(blank);
    for (const name of trackedProfiles()) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      profile.append(option);
    }
    profile.value = editorProfile;
    profile.disabled = editorPending !== undefined;
    profile.addEventListener('change', (event) => {
      const current = event.currentTarget;
      if (!(current instanceof HTMLSelectElement)) return;
      editorProfile = current.value;
      editorSkills = [];
      editorSkillId = '';
      editorContent = '';
      void loadEditorSkills();
    });
    profileLabel.append(profile);

    skills.textContent = message(state.locale, 'editorSkills');
    for (const entry of editorSkills) {
      const item = document.createElement('button');
      item.type = 'button';
      item.disabled = editorPending !== undefined;
      item.textContent = entry.drift
        ? `${entry.id} (${message(state.locale, 'editorDrift')})`
        : entry.id;
      item.addEventListener('click', () => {
        editorSkillId = entry.id;
        void loadEditorContent();
      });
      skills.append(item);
    }

    skillLabel.textContent = message(state.locale, 'editorNewSkill');
    skill.type = 'text';
    skill.value = editorSkillId;
    skill.disabled = editorPending !== undefined;
    skill.addEventListener('input', (event) => {
      const current = event.currentTarget;
      if (current instanceof HTMLInputElement) editorSkillId = current.value.trim();
    });
    skillLabel.append(skill);
    load.type = 'button';
    load.textContent = message(state.locale, 'editorLoadSkill');
    load.disabled = editorPending !== undefined;
    load.addEventListener('click', () => void loadEditorContent());

    contentLabel.textContent = message(state.locale, 'editorContent');
    editor.value = editorContent;
    editor.disabled = editorPending !== undefined;
    editor.addEventListener('input', (event) => {
      const current = event.currentTarget;
      if (current instanceof HTMLTextAreaElement) editorContent = current.value;
    });
    contentLabel.append(editor);
    save.type = 'button';
    save.textContent = message(state.locale, 'editorSave');
    save.disabled = editorPending !== undefined;
    save.addEventListener('click', () => {
      if (!safeProfile(editorProfile)) {
        setMessageKey('validationEditorProfile');
        return;
      }
      if (!safeSkillId(editorSkillId)) {
        setMessageKey('validationEditorSkill');
        return;
      }
      void submitPlan(
        freshPlanRequest('editSkill', {
          profile: editorProfile,
          skillId: editorSkillId,
          content: editorContent,
        }),
      );
    });
    const pendingKey =
      editorPending === 'skills'
        ? 'editorSkillsPending'
        : editorPending === 'content'
          ? 'editorContentPending'
          : undefined;
    const pendingFeedback = document.createElement('p');
    if (pendingKey !== undefined) {
      pendingFeedback.className = 'compose-feedback compose-feedback-info';
      pendingFeedback.textContent = message(state.locale, pendingKey);
    }
    panel.append(
      heading,
      profileLabel,
      ...(pendingKey === undefined ? [] : [pendingFeedback]),
      skills,
      skillLabel,
      load,
      contentLabel,
      save,
    );
    activeMount.append(panel);
  }

  function renderActiveScreen(): void {
    switch (activeScreen) {
      case 'overview':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'overview', data: overviewData, locale: state.locale }),
          handleReadControl,
        );
        return;
      case 'profile-diff':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'profile-diff', data: diffData, locale: state.locale }),
          handleReadControl,
        );
        return;
      case 'doctor':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'doctor', data: doctorData, locale: state.locale }),
          handleReadControl,
        );
        return;
      case 'pack':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'pack', data: packData, locale: state.locale }),
          handleReadControl,
        );
        return;
      case 'write-review':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'write-review', state, locale: state.locale }),
          handleReviewControl,
        );
        return;
      case 'compose':
        if (composeComposition === undefined) renderComposeScreen();
        return;
      case 'skill-editor':
        renderSkillEditor();
        return;
    }
  }

  function loadActiveScreen(): void {
    if (activeScreen === 'overview' && overviewData === undefined) void refreshOverview();
    if (activeScreen === 'doctor' && doctorData === undefined) void refreshDoctor();
    if (activeScreen === 'skill-editor' && overviewData === undefined) void refreshOverview();
  }

  function showCurrentHash(): void {
    const screen = screenFromHash(window.location.hash);
    if (screen !== 'compose') {
      composeComposition = undefined;
      composeRenderDeferred = false;
    }
    activeScreen = screen;
    refreshTargetCopy();
    renderActiveScreen();
    loadActiveScreen();
  }

  function selectScreen(screen: BrowserScreen): void {
    const desiredHash = `#${screen}`;
    if (window.location.hash === desiredHash) showCurrentHash();
    else window.location.hash = desiredHash;
  }

  window.addEventListener('hashchange', showCurrentHash);
  operationSelect.addEventListener('change', () => {
    refreshTargetCopy();
    setMessage('');
  });

  chineseButton.addEventListener('click', () => dispatch({ type: 'set-locale', locale: 'zh' }));
  englishButton.addEventListener('click', () => dispatch({ type: 'set-locale', locale: 'en' }));

  function dispatch(action: BrowserAction): void {
    const previousLocale = state.locale;
    state = reduceBrowserState(state, action);
    if (state.locale !== previousLocale) {
      renderControls();
      renderActiveScreen();
      return;
    }
    renderIfActive('write-review');
  }

  async function refreshOverview(): Promise<void> {
    const request = { operation: 'list', input: {} } as const satisfies UiRequest;
    const result = await postApi(token, request, state.locale);
    overviewData = result.response.metadata;
    renderIfActive('overview');
  }

  async function refreshDoctor(): Promise<void> {
    const request = { operation: 'doctor', input: {} } as const satisfies UiRequest;
    const result = await postApi(token, request, state.locale);
    doctorData = result.response;
    renderIfActive('doctor');
  }

  async function refreshDiff(): Promise<void> {
    const profile = target.value.trim();
    if (profile.length === 0) {
      diffData = {};
      setMessageKey('validationMissingDiffProfile');
      renderIfActive('profile-diff');
      return;
    }
    const request = {
      operation: 'diff',
      input: { profile, checkUpdates: true },
    } as const satisfies UiRequest;
    const result = await postApi(token, request, state.locale);
    diffData = result.response.metadata;
    renderIfActive('profile-diff');
  }

  async function requestComposePreview(): Promise<void> {
    if (!safeProfile(composeProfile)) {
      composeValidation = 'validationComposeProfile';
      renderIfActive('compose');
      return;
    }
    if (composeSources.length === 0 || composeSources.some((source) => source.from.length === 0)) {
      composeValidation = 'validationComposeSource';
      renderIfActive('compose');
      return;
    }
    const request = {
      operation: 'composePreview',
      input: { spec: composeSpec(composeProfile, composeSources, composeResolutions) },
    } as const satisfies UiRequest;
    const revision = composePreviewRevision;
    const requestId = ++composePreviewRequest;
    composePreviewPending = true;
    renderIfActive('compose');
    try {
      const result = await postApi(token, request, state.locale);
      if (revision !== composePreviewRevision || requestId !== composePreviewRequest) return;
      composePreview = result.response;
      composeSkillCatalog = previewSkillCatalog(composePreview, composeSources);
      composeHasSuccessfulPreview = isSuccessfulComposePreview(composePreview);
      composePreviewStale = false;
      if (!previewRequiresUnknownLicenseAcknowledgement(composePreview))
        composeAcknowledgement = false;
      composeValidation = undefined;
      composeResolutions = validComposeResolutions(
        composeResolutions,
        composeSources,
        composeSkillCatalog,
      );
    } finally {
      composePreviewPending = false;
      renderIfActive('compose');
    }
  }

  async function loadEditorSkills(): Promise<void> {
    if (!safeProfile(editorProfile)) return;
    const request = {
      operation: 'diff',
      input: { profile: editorProfile },
    } as const satisfies UiRequest;
    editorPending = 'skills';
    renderIfActive('skill-editor');
    try {
      const result = await postApi(token, request, state.locale);
      editorSkills = editorSkillsFromDiff(result.response.metadata);
    } finally {
      editorPending = undefined;
      renderIfActive('skill-editor');
    }
  }

  async function loadEditorContent(): Promise<void> {
    if (!safeProfile(editorProfile)) {
      setMessageKey('validationEditorProfile');
      return;
    }
    if (!safeSkillId(editorSkillId)) {
      setMessageKey('validationEditorSkill');
      return;
    }
    const request = {
      operation: 'skillContent',
      input: { profile: editorProfile, skillId: editorSkillId },
    } as const satisfies UiRequest;
    editorPending = 'content';
    renderIfActive('skill-editor');
    try {
      const result = await postApi(token, request, state.locale);
      const metadata = previewMetadata(result.response);
      editorContent = typeof metadata.content === 'string' ? metadata.content : '';
    } finally {
      editorPending = undefined;
      renderIfActive('skill-editor');
    }
  }

  async function submitPlan(request: UiWriteRequest): Promise<void> {
    selectScreen('write-review');
    dispatch({ type: 'plan', request });
    if (state.phase !== 'planning') return;
    const result = await postApi(token, state.request, state.locale);
    dispatch({ type: 'plan-success', response: result.response, httpStatus: result.status });
  }

  async function submitApply(): Promise<void> {
    dispatch({ type: 'apply' });
    if (state.phase !== 'applying') return;
    const result = await postApi(token, state.request, state.locale);
    dispatch({ type: 'response', response: result.response, httpStatus: result.status });
    if (result.status === 409) setMessageKey('planChanged');
  }

  async function retryPlan(): Promise<void> {
    if (state.phase === 'idle' || state.phase === 'planning') return;
    await submitPlan(freshPlanRequest(state.operation, state.input));
  }

  function profileFor(control: BrowserControlNode): string | undefined {
    if (
      control.itemIndex === undefined ||
      !record(overviewData) ||
      !Array.isArray(overviewData.profiles)
    )
      return undefined;
    const profile = overviewData.profiles[control.itemIndex];
    return record(profile) && profile.status === 'tracked' && typeof profile.profile === 'string'
      ? profile.profile
      : undefined;
  }

  function packDetailsFor(control: BrowserControlNode): Record<string, unknown> | undefined {
    if (
      control.itemIndex === undefined ||
      !record(overviewData) ||
      !Array.isArray(overviewData.profiles)
    )
      return undefined;
    const profile = overviewData.profiles[control.itemIndex];
    if (!record(profile) || !record(profile.packDetails)) return undefined;
    return profile.packDetails;
  }

  function openProfileDiff(control: BrowserControlNode): void {
    const profile = profileFor(control);
    if (profile === undefined) {
      setMessageKey('validationMissingProfileForDiff');
      return;
    }
    target.value = profile;
    selectScreen('profile-diff');
    void refreshDiff();
  }

  function handleReadControl(control: BrowserControlNode): void {
    switch (control.action) {
      case 'view-profile':
      case 'view-diff':
        openProfileDiff(control);
        return;
      case 'view-doctor':
        doctorData = undefined;
        selectScreen('doctor');
        return;
      case 'view-pack': {
        const details = packDetailsFor(control);
        if (details === undefined) {
          setMessageKey('validationNoPackDetails');
          return;
        }
        packData = details;
        selectScreen('pack');
        return;
      }
      case 'update':
      case 'uninstall':
      case 'restore': {
        const profile = profileFor(control);
        if (profile === undefined) {
          setMessageKey('validationMissingTrackedProfile');
          return;
        }
        operationSelect.value = control.action;
        target.value = profile;
        void submitPlan(freshPlanRequest(control.action, { profile }));
        return;
      }
      default:
        return;
    }
  }

  function handleReviewControl(control: BrowserControlNode, event: Event): void {
    switch (control.action) {
      case 'plan': {
        const request = requestFromCurrentForm();
        if (request === undefined) {
          return;
        }
        void submitPlan(request);
        return;
      }
      case 'retry-plan':
        void retryPlan();
        return;
      case 'grant': {
        if (state.phase !== 'reviewing' || control.itemIndex === undefined) return;
        const permission = state.required[control.itemIndex];
        if (permission === undefined) return;
        const currentTarget = event.currentTarget;
        const granted = currentTarget instanceof HTMLInputElement ? currentTarget.checked : false;
        dispatch({ type: 'grant', permission, granted });
        return;
      }
      case 'confirm-danger-full-access': {
        const currentTarget = event.currentTarget;
        const confirmed =
          currentTarget instanceof HTMLInputElement
            ? currentTarget.checked
            : state.phase === 'reviewing' && state.dangerConfirmed;
        dispatch({ type: 'confirm-danger-full-access', confirmed });
        return;
      }
      case 'apply':
        void submitApply();
        return;
      case 'reset':
        dispatch({ type: 'reset' });
        return;
      default:
        return;
    }
  }

  planButton.addEventListener('click', () => {
    const request = requestFromCurrentForm();
    if (request === undefined) {
      return;
    }
    void submitPlan(request);
  });
  diffButton.addEventListener('click', () => {
    selectScreen('profile-diff');
    void refreshDiff();
  });
  resetButton.addEventListener('click', () => dispatch({ type: 'reset' }));

  showCurrentHash();

  return { refreshOverview, refreshDoctor, refreshDiff };
}

function autoStart(): void {
  const root = document.getElementById('app') ?? document.body;
  if (root !== null) startBrowserUi(root);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', autoStart, { once: true });
  else autoStart();
}
