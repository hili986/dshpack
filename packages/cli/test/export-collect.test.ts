import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildPluginFacts,
  collectOptionalAssets,
  packDiagnostic,
  scanMaterials,
  testedVersion,
} from '../src/export/collect.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-export-collect-'));
  temporaryRoots.push(root);
  return root;
}

async function packageJson(root: string, name: string, value: unknown): Promise<void> {
  const directory = join(root, 'node_modules', ...name.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('export collection', () => {
  it('creates safe diagnostics and accepts only verified dsh version strings', () => {
    expect(packDiagnostic('E_TEST', 'test', 'path')).toMatchObject({
      code: 'E_TEST',
      severity: 'error',
      path: 'path',
    });
    expect(testedVersion('0.1.0-rc.6\n')).toBe('0.1.0-rc.6');
    expect(testedVersion('invalid\n')).toBeUndefined();
  });

  it('reconciles bundles with dependencies, installed metadata, and verified or opaque locks', async () => {
    const root = await temporaryRoot();
    await packageJson(root, 'bad-json', '{');
    await packageJson(root, 'without-patch', { name: 'without-patch' });
    await packageJson(root, 'verified', {
      name: 'verified',
      dsh: { bundle: { patch: './patch.yml' } },
    });
    await packageJson(root, 'opaque', {
      name: 'opaque',
      dsh: { bundle: { patch: './patch.yml' } },
    });
    const dependencies = {
      'bad-git': 'github:owner/repo#main',
      'missing-package': '1.0.0',
      'bad-json': '1.0.0',
      'without-patch': '1.0.0',
      verified: '1.0.0',
      opaque: '1.0.0',
    };
    const bundles = [
      '@deepseek-ai/dsh-base',
      'missing-dependency',
      'bad-git',
      'missing-package',
      'bad-json',
      'without-patch',
      'verified',
      'opaque',
    ];
    const lock = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      verified: {specifier: 1.0.0, version: 1.0.0}',
      'packages:',
      '  verified@1.0.0: {resolution: {integrity: sha512-AQID}}',
      '',
    ].join('\n');

    const closed = await buildPluginFacts(root, dependencies, bundles, lock, false);
    expect(closed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'E_EXPORT_BUNDLE_DEPENDENCY', path: 'missing-dependency' }),
        expect.objectContaining({ code: 'E_EXPORT_GIT_PIN', path: 'bad-git' }),
        expect.objectContaining({
          code: 'E_EXPORT_BUNDLE_PACKAGE',
          path: expect.stringContaining('missing-package'),
        }),
        expect.objectContaining({
          code: 'E_EXPORT_BUNDLE_PACKAGE',
          path: expect.stringContaining('bad-json'),
        }),
        expect.objectContaining({
          code: 'E_EXPORT_BUNDLE_PATCH',
          path: expect.stringContaining('without-patch'),
        }),
        expect.objectContaining({ code: 'E_LOCK_IMPORTER_MISSING' }),
      ]),
    );
    expect(closed.plugins).toContainEqual(expect.objectContaining({ name: 'verified' }));
    expect(closed.locked).toContainEqual(
      expect.objectContaining({
        name: 'verified',
        integrity: { kind: 'npm-sri', value: 'sha512-AQID' },
      }),
    );

    const opaque = await buildPluginFacts(root, { opaque: '1.0.0' }, ['opaque'], undefined, true);
    expect(opaque).toMatchObject({
      diagnostics: [],
      unverified: true,
      locked: [
        expect.objectContaining({ integrity: expect.objectContaining({ kind: 'unverified' }) }),
      ],
    });
  });

  it('collects requested skills and presets while rejecting reserved ids and unsafe settings states', async () => {
    const home = await temporaryRoot();
    await mkdir(join(home, 'skills', 'demo-skill'), { recursive: true });
    await writeFile(join(home, 'skills', 'demo-skill', 'SKILL.md'), '# skill\n', 'utf8');
    await mkdir(join(home, '.agent-presets', 'demo-preset'), { recursive: true });
    await writeFile(
      join(home, '.agent-presets', 'demo-preset', 'agent.cordis.yml'),
      'agents: []\n',
      'utf8',
    );
    const input = { dshHome: home, output: join(home, 'output') };

    const optional = await collectOptionalAssets({
      ...input,
      includeSkills: true,
      includePresets: ['demo-preset', 'standard', 'Bad_ID'],
    });
    expect(optional.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'skills/demo-skill/SKILL.md' }),
        expect.objectContaining({ path: 'presets/demo-preset/agent.cordis.yml' }),
      ]),
    );
    expect(optional.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'E_EXPORT_PRESET', path: 'standard' }),
        expect.objectContaining({ code: 'E_EXPORT_PRESET', path: 'Bad_ID' }),
      ]),
    );

    await expect(collectOptionalAssets({ ...input, includeSettings: true })).resolves.toMatchObject(
      { diagnostics: [], materials: [] },
    );
    await writeFile(join(home, 'settings.yaml'), '- list\n', 'utf8');
    await expect(collectOptionalAssets({ ...input, includeSettings: true })).resolves.toMatchObject(
      { diagnostics: [expect.objectContaining({ code: 'E_EXPORT_SETTINGS' })] },
    );
    await writeFile(join(home, 'settings.yaml'), 'ui-theme: { mode: dark }\n', 'utf8');
    await expect(collectOptionalAssets({ ...input, includeSettings: true })).resolves.toMatchObject(
      { diagnostics: [], materials: [] },
    );
  });

  it('fails closed on settings secrets unless redact is requested and rescans material content', async () => {
    const home = await temporaryRoot();
    const token = 'sk-TESTONLY-012345678901234567890123';
    await writeFile(join(home, 'settings.yaml'), `agent-presets:\n  selected: ${token}\n`, 'utf8');
    const input = { dshHome: home, output: join(home, 'output'), includeSettings: true };

    const closed = await collectOptionalAssets(input);
    expect(closed.diagnostics).toContainEqual(expect.objectContaining({ code: 'E_SECRET_TOKEN' }));
    expect(JSON.stringify(closed.diagnostics)).not.toContain(token.slice(0, 8));

    const redacted = await collectOptionalAssets({ ...input, redact: true });
    expect(redacted).toMatchObject({ diagnostics: [], redactions: ['settings/agent-presets.yml'] });
    expect(Buffer.from(redacted.materials[0]?.bytes ?? []).toString('utf8')).toContain(
      '<REDACTED>',
    );
    expect(
      scanMaterials([{ path: 'skills/demo.md', bytes: Buffer.from(`token: ${token}\n`) }]),
    ).toContainEqual(expect.objectContaining({ code: 'E_SECRET_KEY' }));
  });
});
