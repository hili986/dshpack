import type {
  BrowserControlNode,
  BrowserViewClass,
  BrowserViewNode,
  BrowserViewTag,
} from './view.js';

/** A control callback receives the immutable description node, never user data from an attribute. */
export type BrowserControlHandler = (control: BrowserControlNode, event: Event) => void;

function trustedElement(document: Document, tag: BrowserViewTag): HTMLElement {
  // Keep the tag set explicit. A value from a pack or diagnostic must never become a DOM tag.
  switch (tag) {
    case 'main':
      return document.createElement('main');
    case 'section':
      return document.createElement('section');
    case 'header':
      return document.createElement('header');
    case 'h1':
      return document.createElement('h1');
    case 'h2':
      return document.createElement('h2');
    case 'h3':
      return document.createElement('h3');
    case 'p':
      return document.createElement('p');
    case 'ul':
      return document.createElement('ul');
    case 'li':
      return document.createElement('li');
    case 'dl':
      return document.createElement('dl');
    case 'dt':
      return document.createElement('dt');
    case 'dd':
      return document.createElement('dd');
    case 'details':
      return document.createElement('details');
    case 'summary':
      return document.createElement('summary');
    case 'table':
      return document.createElement('table');
    case 'thead':
      return document.createElement('thead');
    case 'tbody':
      return document.createElement('tbody');
    case 'tr':
      return document.createElement('tr');
    case 'th':
      return document.createElement('th');
    case 'td':
      return document.createElement('td');
    case 'code':
      return document.createElement('code');
  }
}

/** Keep presentation names closed even if an untyped caller constructs a description tree. */
function trustedClass(value: BrowserViewClass): BrowserViewClass | undefined {
  switch (value) {
    case 'page':
    case 'page-header':
    case 'panel':
    case 'summary-grid':
    case 'data-table':
    case 'status-badge':
    case 'status-tracked':
    case 'status-untracked':
    case 'status-reserved':
    case 'status-broken':
    case 'severity-info':
    case 'severity-warning':
    case 'severity-error':
    case 'callout':
    case 'review-status':
    case 'compose-source':
    case 'compose-skill-option':
    case 'compose-resolved':
      return value;
    default:
      return undefined;
  }
}

function textElement(document: Document, value: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.textContent = value;
  return element;
}

function appendChildren(
  element: HTMLElement,
  children: readonly BrowserViewNode[],
  document: Document,
  onControl: BrowserControlHandler,
): void {
  for (const child of children) element.append(renderBrowserNode(document, child, onControl));
}

function renderControl(
  document: Document,
  node: BrowserControlNode,
  onControl: BrowserControlHandler,
): HTMLElement {
  if (node.control === 'checkbox') {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = node.checked === true;
    input.disabled = node.disabled;
    input.addEventListener('change', (event) => onControl(node, event));
    label.append(input, textElement(document, node.label));
    return label;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = node.disabled;
  button.textContent = node.label;
  button.addEventListener('click', (event) => onControl(node, event));
  return button;
}

/** Materialize one safe view node with no HTML parsing or user-controlled attributes. */
export function renderBrowserNode(
  document: Document,
  node: BrowserViewNode,
  onControl: BrowserControlHandler = () => undefined,
): HTMLElement {
  if (node.type === 'text') return textElement(document, node.text);
  if (node.type === 'control') return renderControl(document, node, onControl);

  const element = trustedElement(document, node.tag);
  if (node.tag === 'details' && node.attrs?.open === true)
    (element as HTMLDetailsElement).open = true;
  const className = node.attrs?.className;
  if (className !== undefined) {
    const safeClassName = trustedClass(className);
    if (safeClassName !== undefined) element.classList.add(safeClassName);
  }
  appendChildren(element, node.children, document, onControl);
  return element;
}

/** Replace a mount point's children with a freshly materialized description tree. */
export function mountBrowserView(
  root: HTMLElement,
  node: BrowserViewNode,
  onControl: BrowserControlHandler = () => undefined,
): void {
  root.textContent = '';
  root.append(renderBrowserNode(root.ownerDocument, node, onControl));
}
