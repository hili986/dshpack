type Listener = (event: Event) => void;

export class FakeElement {
  readonly children: FakeElement[] = [];
  disabled = false;
  checked = false;
  hidden = false;
  type = '';
  value = '';
  placeholder = '';
  private readonly classNames = new Set<string>();
  readonly classList = {
    add: (...tokens: string[]): void => {
      for (const token of tokens) this.classNames.add(token);
    },
    contains: (token: string): boolean => this.classNames.has(token),
  };
  private text = '';
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  get textContent(): string {
    return `${this.text}${this.children.map((child) => child.textContent).join('')}`;
  }

  set textContent(value: string | null) {
    this.text = value ?? '';
    this.children.splice(0);
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
    if (this.tagName === 'select' && this.value.length === 0) {
      const firstOption = this.children.find((child) => child.tagName === 'option');
      if (firstOption !== undefined) this.value = firstOption.value;
    }
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback: Listener =
      typeof listener === 'function' ? listener : (event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  fire(type: string): void {
    const event = { currentTarget: this, target: this, type } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export class FakeInputElement extends FakeElement {}

export class FakeDocument {
  readonly body: FakeElement;
  readyState: DocumentReadyState = 'complete';
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    this.body = this.createElement('body');
  }

  createElement(tag: string): FakeElement {
    return tag === 'input' ? new FakeInputElement(this, tag) : new FakeElement(this, tag);
  }

  getElementById(_id: string): FakeElement | null {
    return null;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback: Listener =
      typeof listener === 'function' ? listener : (event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  fire(type: string): void {
    const event = { currentTarget: this, target: this, type } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export class FakeWindow {
  private readonly listeners = new Map<string, Listener[]>();
  private readonly url: URL;
  readonly location: { readonly href: string; hash: string };

  constructor(href: string) {
    this.url = new URL(href);
    const owner = this;
    this.location = {
      get href(): string {
        return owner.url.href;
      },
      get hash(): string {
        return owner.url.hash;
      },
      set hash(value: string) {
        const previous = owner.url.hash;
        owner.url.hash = value;
        if (owner.url.hash !== previous) owner.fire('hashchange');
      },
    };
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback: Listener =
      typeof listener === 'function' ? listener : (event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  private fire(type: string): void {
    const event = { currentTarget: this, target: this, type } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function descendants(root: FakeElement): readonly FakeElement[] {
  return [root, ...root.children.flatMap(descendants)];
}

export function visibleText(root: FakeElement): string {
  return descendants(root)
    .filter((element) => !element.hidden)
    .map((element) => element.textContent)
    .join('');
}

export function elementWithText(root: FakeElement, text: string): FakeElement | undefined {
  return descendants(root).find((element) => element.textContent === text);
}
