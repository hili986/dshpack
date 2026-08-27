import type { UiRequest, UiResponse, UiWriteOperation, UiWriteRequest } from 'dshpack';

import { mountBrowserView } from './dom.js';
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

type BrowserScreen = 'overview' | 'profile-diff' | 'doctor' | 'pack' | 'write-review';

export interface BrowserUiController {
  readonly refreshOverview: () => Promise<void>;
  readonly refreshDoctor: () => Promise<void>;
  readonly refreshDiff: () => Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failureResponse(code: string, message: string): UiResponse {
  return {
    diagnostics: [{ code, severity: 'error', message, evidence: 'local' }],
    exitCode: 1 as UiResponse['exitCode'],
    metadata: {},
  };
}

function responseFrom(value: unknown): UiResponse {
  if (
    record(value) &&
    Array.isArray(value.diagnostics) &&
    typeof value.exitCode === 'number' &&
    record(value.metadata)
  )
    return value as unknown as UiResponse;
  return failureResponse('E_UI_RESPONSE', 'The UI server returned an invalid response.');
}

async function postApi(token: string | null, request: UiRequest): Promise<ApiResult> {
  if (token === null || token.length === 0)
    return { status: 401, response: failureResponse('E_UI_TOKEN', 'The UI token is missing.') };

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
    return { status: response.status, response: responseFrom(body) };
  } catch {
    return {
      status: 0,
      response: failureResponse('E_UI_NETWORK', 'The UI server could not be reached.'),
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

function operationOptions(document: Document, select: HTMLSelectElement): void {
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
    option.textContent = operation;
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
    default:
      return 'overview';
  }
}

function navigationButton(
  document: Document,
  screen: BrowserScreen,
  select: (screen: BrowserScreen) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = screen;
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

  root.textContent = '';
  const controls = document.createElement('section');
  const controlsHeading = document.createElement('h1');
  const operationLabel = document.createElement('label');
  const operationSelect = document.createElement('select');
  const targetLabel = document.createElement('label');
  const target = document.createElement('input');
  const planButton = document.createElement('button');
  const resetButton = document.createElement('button');
  const navigation = document.createElement('nav');
  const message = document.createElement('p');
  const activeMount = document.createElement('section');

  controlsHeading.textContent = 'Pack management';
  operationLabel.textContent = 'Operation';
  targetLabel.textContent = 'Source or profile';
  target.type = 'text';
  planButton.type = 'button';
  planButton.textContent = 'Plan';
  resetButton.type = 'button';
  resetButton.textContent = 'Reset review';
  operationOptions(document, operationSelect);
  operationLabel.append(operationSelect);
  targetLabel.append(target);
  controls.append(
    controlsHeading,
    operationLabel,
    targetLabel,
    planButton,
    resetButton,
    navigation,
    message,
  );
  root.append(controls, activeMount);

  function setMessage(value: string): void {
    message.textContent = value;
  }

  function renderIfActive(screen: BrowserScreen): void {
    if (activeScreen === screen) renderActiveScreen();
  }

  function renderActiveScreen(): void {
    switch (activeScreen) {
      case 'overview':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'overview', data: overviewData }),
          handleReadControl,
        );
        return;
      case 'profile-diff':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'profile-diff', data: diffData }),
          handleReadControl,
        );
        return;
      case 'doctor':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'doctor', data: doctorData }),
          handleReadControl,
        );
        return;
      case 'pack':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'pack', data: packData }),
          handleReadControl,
        );
        return;
      case 'write-review':
        mountBrowserView(
          activeMount,
          renderBrowserView({ kind: 'write-review', state }),
          handleReviewControl,
        );
        return;
    }
  }

  function loadActiveScreen(): void {
    if (activeScreen === 'overview' && overviewData === undefined) void refreshOverview();
    if (activeScreen === 'doctor' && doctorData === undefined) void refreshDoctor();
  }

  function showCurrentHash(): void {
    activeScreen = screenFromHash(window.location.hash);
    renderActiveScreen();
    loadActiveScreen();
  }

  function selectScreen(screen: BrowserScreen): void {
    const desiredHash = `#${screen}`;
    if (window.location.hash === desiredHash) showCurrentHash();
    else window.location.hash = desiredHash;
  }

  for (const screen of ['overview', 'profile-diff', 'doctor', 'pack', 'write-review'] as const)
    navigation.append(navigationButton(document, screen, selectScreen));
  window.addEventListener('hashchange', showCurrentHash);

  function dispatch(action: BrowserAction): void {
    state = reduceBrowserState(state, action);
    renderIfActive('write-review');
  }

  async function refreshOverview(): Promise<void> {
    const request = { operation: 'list', input: {} } as const satisfies UiRequest;
    const result = await postApi(token, request);
    overviewData = result.response.metadata;
    renderIfActive('overview');
  }

  async function refreshDoctor(): Promise<void> {
    const request = { operation: 'doctor', input: {} } as const satisfies UiRequest;
    const result = await postApi(token, request);
    doctorData = result.response;
    renderIfActive('doctor');
  }

  async function refreshDiff(): Promise<void> {
    const profile = target.value.trim();
    if (profile.length === 0) {
      diffData = {};
      setMessage('Enter a profile before loading its diff.');
      renderIfActive('profile-diff');
      return;
    }
    const request = {
      operation: 'diff',
      input: { profile, checkUpdates: true },
    } as const satisfies UiRequest;
    const result = await postApi(token, request);
    diffData = result.response.metadata;
    renderIfActive('profile-diff');
  }

  async function submitPlan(request: UiWriteRequest): Promise<void> {
    selectScreen('write-review');
    dispatch({ type: 'plan', request });
    if (state.phase !== 'planning') return;
    const result = await postApi(token, state.request);
    dispatch({ type: 'plan-success', response: result.response, httpStatus: result.status });
  }

  async function submitApply(): Promise<void> {
    dispatch({ type: 'apply' });
    if (state.phase !== 'applying') return;
    const result = await postApi(token, state.request);
    dispatch({ type: 'response', response: result.response, httpStatus: result.status });
    if (result.status === 409) setMessage('The plan changed. Review a fresh plan.');
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
      setMessage('Select a profile before loading its diff.');
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
          setMessage('Pack details are unavailable.');
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
          setMessage('Select a tracked profile before planning.');
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
        const operation = writeOperation(operationSelect.value);
        const request =
          operation === undefined ? undefined : requestFromForm(operation, target.value.trim());
        if (request === undefined) {
          setMessage('Enter a source or profile before planning.');
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
    const operation = writeOperation(operationSelect.value);
    const request =
      operation === undefined ? undefined : requestFromForm(operation, target.value.trim());
    if (request === undefined) {
      setMessage('Enter a source or profile before planning.');
      return;
    }
    void submitPlan(request);
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
