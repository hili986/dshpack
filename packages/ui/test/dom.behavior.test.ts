import { describe, expect, it } from 'vitest';

import { mountBrowserView, renderBrowserNode } from '../src/dom.js';
import type { BrowserViewClass, BrowserViewNode, BrowserViewTag } from '../src/view.js';
import { descendants, FakeDocument, type FakeElement } from './fake-dom.js';

const tags: readonly BrowserViewTag[] = [
  'main',
  'section',
  'header',
  'h1',
  'h2',
  'h3',
  'p',
  'ul',
  'li',
  'dl',
  'dt',
  'dd',
  'details',
  'summary',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'code',
];

const classes: readonly BrowserViewClass[] = [
  'page',
  'page-header',
  'panel',
  'summary-grid',
  'data-table',
  'status-badge',
  'status-tracked',
  'status-untracked',
  'status-reserved',
  'status-broken',
  'severity-info',
  'severity-warning',
  'severity-error',
  'callout',
  'review-status',
  'compose-source',
  'compose-skill-option',
  'compose-resolved',
];

function document(): FakeDocument {
  return new FakeDocument();
}

describe('imperative DOM adapter', () => {
  it('materializes every fixed view tag and treats supplied values as text', () => {
    const fake = document();

    for (const tag of tags) {
      const node: BrowserViewNode = {
        type: 'element',
        tag,
        ...(tag === 'details' ? { attrs: { open: true } } : {}),
        children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }],
      };
      const rendered = renderBrowserNode(
        fake as unknown as Document,
        node,
      ) as unknown as FakeElement;
      expect(rendered.tagName).toBe(tag);
      expect(descendants(rendered).some((child) => child.tagName === 'img')).toBe(false);
    }
  });

  it('materializes only the fixed presentation class set', () => {
    const fake = document();
    for (const className of classes) {
      const rendered = renderBrowserNode(fake as unknown as Document, {
        type: 'element',
        tag: 'section',
        attrs: { className },
        children: [],
      }) as unknown as FakeElement;
      expect(rendered.classList.contains(className)).toBe(true);
    }

    const hostile = renderBrowserNode(fake as unknown as Document, {
      type: 'element',
      tag: 'section',
      attrs: { className: 'pack-controlled-selector' as BrowserViewClass },
      children: [],
    }) as unknown as FakeElement;
    expect(hostile.classList.contains('pack-controlled-selector')).toBe(false);
  });

  it('emits immutable control descriptions from button and checkbox events', () => {
    const fake = document();
    const observed: string[] = [];
    const button = renderBrowserNode(
      fake as unknown as Document,
      {
        type: 'control',
        control: 'button',
        action: 'apply',
        label: 'Apply',
        disabled: false,
        children: [{ type: 'text', text: 'Apply' }],
      },
      (control) => observed.push(control.action),
    ) as unknown as FakeElement;
    const checkbox = renderBrowserNode(
      fake as unknown as Document,
      {
        type: 'control',
        control: 'checkbox',
        action: 'grant',
        label: 'Grant',
        disabled: true,
        checked: true,
        itemIndex: 0,
        children: [{ type: 'text', text: 'Grant' }],
      },
      (control) => observed.push(control.action),
    ) as unknown as FakeElement;

    button.fire('click');
    const input = descendants(checkbox).find((element) => element.tagName === 'input');
    expect(input?.checked).toBe(true);
    expect(input?.disabled).toBe(true);
    input?.fire('change');
    expect(observed).toEqual(['apply', 'grant']);
  });

  it('replaces a mount point rather than retaining prior view nodes', () => {
    const fake = document();
    const root = fake.createElement('section');
    root.append(fake.createElement('p'));

    mountBrowserView(root as unknown as HTMLElement, {
      type: 'element',
      tag: 'main',
      children: [{ type: 'text', text: 'new view' }],
    });

    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.tagName).toBe('main');
  });

  it('accepts text and closed disclosure nodes with the default inert control callback', () => {
    const fake = document();
    const text = renderBrowserNode(fake as unknown as Document, {
      type: 'text',
      text: 'literal <script>value</script>',
    }) as unknown as FakeElement;
    const closed = renderBrowserNode(fake as unknown as Document, {
      type: 'element',
      tag: 'details',
      children: [],
    }) as unknown as FakeElement;

    expect(text.textContent).toBe('literal <script>value</script>');
    expect(closed.tagName).toBe('details');

    const control = renderBrowserNode(fake as unknown as Document, {
      type: 'control',
      control: 'button',
      action: 'reset',
      label: 'Reset',
      disabled: false,
      children: [{ type: 'text', text: 'Reset' }],
    }) as unknown as FakeElement;
    control.fire('click');
  });

  it('uses the default inert callback when mounting a control tree', () => {
    const fake = document();
    const root = fake.createElement('section');
    mountBrowserView(root as unknown as HTMLElement, {
      type: 'control',
      control: 'checkbox',
      action: 'grant',
      label: 'Grant safely',
      checked: false,
      disabled: false,
      children: [{ type: 'text', text: 'Grant safely' }],
    });

    descendants(root)
      .find((element) => element.tagName === 'input')
      ?.fire('change');
    expect(root.textContent).toContain('Grant safely');
  });
});
