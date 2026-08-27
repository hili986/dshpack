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

interface ComposeSourceForm {
  readonly from: string;
  readonly skills: readonly string[];
}

interface ComposeResolutionForm {
  readonly id: string;
  readonly mode: 'prefer' | 'rename';
  readonly prefer?: string;
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

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
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

function previewSkills(response: UiResponse | undefined, index: number): readonly string[] {
  const value = previewMetadata(response).sourceSkills;
  if (!Array.isArray(value)) return [];
  const source = value[index];
  return record(source) ? strings(source.skills) : [];
}

function previewConflictIds(response: UiResponse | undefined): readonly string[] {
  const value = previewMetadata(response).conflicts;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    record(item) && typeof item.path === 'string' ? [item.path] : [],
  );
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
  let composePreviewRevision = 0;
  let composePreviewRequest = 0;
  let composeResolutions: readonly ComposeResolutionForm[] = [];
  let composeInstallButton: HTMLButtonElement | undefined;
  let editorProfile = '';
  let editorSkills: readonly EditorSkill[] = [];
  let editorSkillId = '';
  let editorContent = '';

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
    if (activeScreen === screen) renderActiveScreen();
  }

  function composeSourceUpdate(index: number, source: ComposeSourceForm): void {
    composeSources = composeSources.map((current, currentIndex) =>
      currentIndex === index ? source : current,
    );
    composeResolutions = [];
    invalidateComposePreview();
  }

  function invalidateComposePreview(): void {
    composePreviewRevision += 1;
    composePreview = undefined;
    if (composeInstallButton !== undefined) composeInstallButton.disabled = true;
  }

  function composeInstallReady(): boolean {
    return (
      composePreview?.exitCode === 0 &&
      previewMetadata(composePreview).phase === 'preview' &&
      !previewConflictIds(composePreview).some(
        (id) => !composeResolutions.some((item) => item.id === id),
      )
    );
  }

  function renderComposeScreen(): void {
    activeMount.textContent = '';
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

    heading.textContent = message(state.locale, 'composeHeading');
    profileLabel.textContent = message(state.locale, 'composeProfile');
    profile.type = 'text';
    profile.value = composeProfile;
    profile.addEventListener('input', (event) => {
      const current = event.currentTarget;
      if (current instanceof HTMLInputElement) {
        composeProfile = current.value.trim();
        invalidateComposePreview();
      }
    });
    profileLabel.append(profile);

    sources.textContent = message(state.locale, 'composeSource');
    for (const [index, source] of composeSources.entries()) {
      const card = document.createElement('section');
      const sourceLabel = document.createElement('label');
      const sourceInput = document.createElement('input');
      const remove = document.createElement('button');
      const skillsHeading = document.createElement('h3');
      sourceInput.type = 'text';
      sourceInput.placeholder = message(state.locale, 'placeholderComposeSource');
      sourceInput.value = source.from;
      sourceLabel.textContent = `${message(state.locale, 'composeSource')} ${String(index + 1)}`;
      sourceInput.addEventListener('input', (event) => {
        const current = event.currentTarget;
        if (current instanceof HTMLInputElement)
          composeSourceUpdate(index, { ...source, from: current.value.trim() });
      });
      sourceLabel.append(sourceInput);
      remove.type = 'button';
      remove.textContent = message(state.locale, 'composeRemoveSource');
      remove.disabled = composeSources.length === 1;
      remove.addEventListener('click', () => {
        composeSources = composeSources.filter((_, currentIndex) => currentIndex !== index);
        composeResolutions = [];
        invalidateComposePreview();
        renderComposeScreen();
      });
      skillsHeading.textContent = message(state.locale, 'composeSourceSkills');
      card.append(sourceLabel, remove, skillsHeading);
      for (const skill of previewSkills(composePreview, index)) {
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
        skillLabel.append(checked, skillText);
        card.append(skillLabel);
      }
      sources.append(card);
    }

    for (const from of previewResolvedSources(composePreview)) {
      const resolved = document.createElement('p');
      resolved.textContent = from;
      resolvedSources.append(resolved);
    }

    addSource.type = 'button';
    addSource.textContent = message(state.locale, 'composeAddSource');
    addSource.addEventListener('click', () => {
      composeSources = [...composeSources, { from: '', skills: [] }];
      composeResolutions = [];
      invalidateComposePreview();
      renderComposeScreen();
    });

    const conflictIds = previewConflictIds(composePreview);
    conflicts.textContent = message(state.locale, 'composeConflicts');
    for (const id of conflictIds) {
      const card = document.createElement('section');
      const label = document.createElement('p');
      const prefer = document.createElement('input');
      const rename = document.createElement('input');
      const sourceSelect = document.createElement('select');
      const sourceLabel = document.createElement('label');
      const preferText = document.createElement('span');
      const renameText = document.createElement('span');
      const resolution = composeResolutions.find((item) => item.id === id);
      label.textContent = id;
      prefer.type = 'radio';
      prefer.checked = resolution?.mode === 'prefer';
      prefer.addEventListener('change', () => {
        composeResolutions = [
          ...composeResolutions.filter((item) => item.id !== id),
          { id, mode: 'prefer', prefer: resolution?.prefer ?? composeSources[0]?.from ?? '' },
        ];
        renderComposeScreen();
      });
      rename.type = 'radio';
      rename.checked = resolution?.mode === 'rename';
      rename.addEventListener('change', () => {
        composeResolutions = [
          ...composeResolutions.filter((item) => item.id !== id),
          { id, mode: 'rename' },
        ];
        renderComposeScreen();
      });
      preferText.textContent = message(state.locale, 'composeResolvePrefer');
      renameText.textContent = message(state.locale, 'composeResolveRename');
      sourceLabel.textContent = message(state.locale, 'composePreferSource');
      for (const source of composeSources) {
        const option = document.createElement('option');
        option.value = source.from;
        option.textContent = source.from;
        option.selected = source.from === (resolution?.prefer ?? composeSources[0]?.from);
        sourceSelect.append(option);
      }
      sourceSelect.disabled = resolution?.mode !== 'prefer';
      sourceSelect.addEventListener('change', () => {
        composeResolutions = [
          ...composeResolutions.filter((item) => item.id !== id),
          { id, mode: 'prefer', prefer: sourceSelect.value },
        ];
        renderComposeScreen();
      });
      card.append(label, prefer, preferText, rename, renameText);
      card.append(sourceLabel, sourceSelect);
      conflicts.append(card);
    }

    preview.type = 'button';
    preview.textContent = message(state.locale, 'composePreview');
    preview.addEventListener('click', () => void requestComposePreview());
    install.type = 'button';
    install.textContent = message(state.locale, 'composeInstall');
    install.disabled = !composeInstallReady();
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
        }),
      );
    });
    panel.append(
      heading,
      profileLabel,
      sources,
      resolvedSources,
      addSource,
      conflicts,
      preview,
      install,
    );
    activeMount.append(panel);
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
    skill.addEventListener('input', (event) => {
      const current = event.currentTarget;
      if (current instanceof HTMLInputElement) editorSkillId = current.value.trim();
    });
    skillLabel.append(skill);
    load.type = 'button';
    load.textContent = message(state.locale, 'editorLoadSkill');
    load.addEventListener('click', () => void loadEditorContent());

    contentLabel.textContent = message(state.locale, 'editorContent');
    editor.value = editorContent;
    editor.addEventListener('input', (event) => {
      const current = event.currentTarget;
      if (current instanceof HTMLTextAreaElement) editorContent = current.value;
    });
    contentLabel.append(editor);
    save.type = 'button';
    save.textContent = message(state.locale, 'editorSave');
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
    panel.append(heading, profileLabel, skills, skillLabel, load, contentLabel, save);
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
        renderComposeScreen();
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
    activeScreen = screenFromHash(window.location.hash);
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
      setMessageKey('validationComposeProfile');
      return;
    }
    if (composeSources.length === 0 || composeSources.some((source) => source.from.length === 0)) {
      setMessageKey('validationComposeSource');
      return;
    }
    const request = {
      operation: 'composePreview',
      input: { spec: composeSpec(composeProfile, composeSources, composeResolutions) },
    } as const satisfies UiRequest;
    const revision = composePreviewRevision;
    const requestId = ++composePreviewRequest;
    const result = await postApi(token, request, state.locale);
    if (revision !== composePreviewRevision || requestId !== composePreviewRequest) return;
    composePreview = result.response;
    const ids = new Set(previewConflictIds(composePreview));
    composeResolutions = composeResolutions.filter((item) => ids.has(item.id));
    renderIfActive('compose');
  }

  async function loadEditorSkills(): Promise<void> {
    if (!safeProfile(editorProfile)) return;
    const request = {
      operation: 'diff',
      input: { profile: editorProfile },
    } as const satisfies UiRequest;
    const result = await postApi(token, request, state.locale);
    editorSkills = editorSkillsFromDiff(result.response.metadata);
    renderIfActive('skill-editor');
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
    const result = await postApi(token, request, state.locale);
    const metadata = previewMetadata(result.response);
    editorContent = typeof metadata.content === 'string' ? metadata.content : '';
    renderIfActive('skill-editor');
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
