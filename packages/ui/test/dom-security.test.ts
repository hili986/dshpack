import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const sourceRoot = new URL('../src/', import.meta.url);
const publicRoot = new URL('../public/', import.meta.url);

async function source(name: string): Promise<string> {
  return readFile(new URL(name, sourceRoot), 'utf8');
}

async function publicAsset(name: string): Promise<string> {
  return readFile(new URL(name, publicRoot), 'utf8');
}

async function allSources(): Promise<readonly string[]> {
  const names = (await readdir(sourceRoot)).filter((name) => name.endsWith('.ts'));
  return Promise.all(names.map((name) => source(name)));
}

describe('browser DOM shell trust boundary', () => {
  it('uses only imperative text-safe DOM construction', async () => {
    const sources = await allSources();
    const combined = sources.join('\n');
    const forbidden = [
      `inner${'HTML'}`,
      `outer${'HTML'}`,
      `insertAdjacent${'HTML'}`,
      'document.write',
    ];

    expect(combined).toContain('createElement');
    expect(combined).toContain('textContent');
    for (const method of forbidden) expect(combined).not.toContain(method);
    expect(combined).not.toMatch(/createElement\(\s*['"](?:a|img)['"]/u);
  });

  it('keeps tokens ephemeral and posts only to the same-origin API', async () => {
    const main = await source('main.ts');
    const forbidden = [`local${'Storage'}`, `session${'Storage'}`, 'document.cookie'];

    expect(main).toContain("searchParams.get('token')");
    expect(main).toMatch(/fetch\(\s*'\/api'/u);
    expect(main).toContain('Authorization');
    expect(main).toContain('Bearer');
    for (const api of forbidden) expect(main).not.toContain(api);
  });

  it('ships a static stylesheet without a pack-controlled CSS channel or external resource', async () => {
    const [html, sources] = await Promise.all([publicAsset('index.html'), allSources()]);
    const styleBlocks = html.match(/<style>[\s\S]*?<\/style>/gu) ?? [];

    expect(styleBlocks).toHaveLength(1);
    expect(html).not.toMatch(/https?:\/\//u);
    for (const source of sources)
      expect(source).not.toMatch(/(?:\.style\b|setAttribute\(\s*['"]style['"])/u);
  });

  it('initializes the four read views and a single plan-review-apply flow', async () => {
    const main = await source('main.ts');

    for (const view of ['overview', 'profile-diff', 'doctor', 'pack'])
      expect(main).toContain(`kind: '${view}'`);
    expect(main).toContain("type: 'plan'");
    expect(main).toContain("type: 'plan-success'");
    expect(main).toContain("type: 'apply'");
    expect(main).toContain('confirm-danger-full-access');
  });

  it('routes permission checkbox state back to the reducer for both grant and revoke', async () => {
    const main = await source('main.ts');

    expect(main).toContain('currentTarget instanceof HTMLInputElement');
    expect(main).toMatch(/granted\s*[,}]/u);
    expect(main).toContain("type: 'grant'");
  });

  it('uses a fixed hash whitelist for view navigation without control data attributes', async () => {
    const main = await source('main.ts');

    expect(main).toContain('window.location.hash');
    expect(main).toContain("window.addEventListener('hashchange'");
    for (const view of ['overview', 'profile-diff', 'doctor', 'pack', 'write-review'])
      expect(main).toContain(`case '${view}'`);
    expect(main).not.toContain('dataset');
  });

  it('mounts only one active view and routes row write actions through the review flow', async () => {
    const main = await source('main.ts');

    expect(main).toContain('activeMount');
    expect(main).not.toContain('.hidden =');
    for (const action of ['update', 'uninstall', 'restore'])
      expect(main).toContain(`case '${action}'`);
    expect(main).toContain('authorizedDangerousPermissions: []');
  });
});
