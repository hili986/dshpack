import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateAndWriteLock, generateLock } from '../src/lock/engine.js';

const roots: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-lock-test-'));
  roots.push(root);
  return root;
}

function manifest(plugins: unknown[] = []): string {
  return `formatVersion: 0\nname: lock-fixture\nversion: 0.1.0\ndescription: Deterministic handwritten pack lock fixture\nauthor: dshpack test\nlicense: MIT\ndsh:\n  tested: [0.1.0-rc.6]\nplugins: ${plugins.length === 0 ? '[]' : JSON.stringify(plugins)}\nmcp: []\ndefaults:\n  permissionPreset: workspace-write\n`;
}

async function makePack(plugins: unknown[] = []): Promise<string> {
  const root = await temporary();
  const pack = join(root, 'pack');
  await mkdir(join(pack, 'patch'), { recursive: true });
  await writeFile(join(pack, 'pack.yml'), manifest(plugins), 'utf8');
  await writeFile(join(pack, 'patch', 'cordis.patch.yml'), '[]\n', 'utf8');
  return pack;
}

interface LockShimOptions {
  addFails?: boolean;
  argsFile?: string;
  installPackage?: boolean;
  listFails?: boolean;
  omitLockfile?: boolean;
}

async function writeDshShim(
  root: string,
  options: LockShimOptions = {},
): Promise<NodeJS.ProcessEnv> {
  const shim = join(root, 'dsh-shim');
  await mkdir(shim);
  const script = join(shim, 'dsh-lock-shim.mjs');
  const source = `import { appendFile, mkdir, writeFile } from 'node:fs/promises';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nconst home = process.env.DSH_HOME;\nconst profile = args[args.indexOf('--profile') + 1];\nconst profileRoot = join(home, 'profiles', profile);\nif (process.env.LOCK_SHIM_ARGS_FILE !== undefined) await appendFile(process.env.LOCK_SHIM_ARGS_FILE, JSON.stringify(args) + '\\n');\nif (args.includes('list')) {\n  if (process.env.LOCK_SHIM_LIST_FAILS === '1') process.exitCode = 1;\n  else {\n    await mkdir(profileRoot, { recursive: true });\n    await writeFile(join(profileRoot, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + profile, private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));\n    await writeFile(join(profileRoot, 'cordis.patch.yml'), '[]\\n');\n    process.stdout.write('[]\\n');\n  }\n} else if (args.includes('add')) {\n  if (process.env.LOCK_SHIM_ADD_FAILS === '1') process.exitCode = 1;\n  else {\n    if (process.env.LOCK_SHIM_OMIT_LOCKFILE !== '1') await writeFile(join(profileRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\\nimporters:\\n  .:\\n    dependencies:\\n      fixture-bundle: {specifier: 1.0.0, version: 1.0.0}\\npackages:\\n  fixture-bundle@1.0.0: {resolution: {integrity: sha512-AQID}}\\n");\n    if (process.env.LOCK_SHIM_INSTALL === '1') {\n      const packageRoot = join(profileRoot, 'node_modules', 'fixture-bundle');\n      await mkdir(packageRoot, { recursive: true });\n      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));\n      await writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\\n');\n      await writeFile(join(profileRoot, 'package.json'), JSON.stringify({ name: 'dsh-profile-' + profile, private: true, dependencies: { 'fixture-bundle': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'fixture-bundle'] } } }));\n    }\n  }\n}\n`;
  await writeFile(script, source, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(
      join(shim, 'dsh.cmd'),
      `@echo off\n"${process.execPath}" "%~dp0dsh-lock-shim.mjs" %*\n`,
      'utf8',
    );
  } else {
    const executable = join(shim, 'dsh');
    await writeFile(
      executable,
      "#!/usr/bin/env node\nawait import('./dsh-lock-shim.mjs');\n",
      'utf8',
    );
    await chmod(executable, 0o755);
  }
  return {
    LOCK_SHIM_ADD_FAILS: options.addFails ? '1' : '0',
    ...(options.argsFile === undefined ? {} : { LOCK_SHIM_ARGS_FILE: options.argsFile }),
    LOCK_SHIM_INSTALL: options.installPackage ? '1' : '0',
    LOCK_SHIM_LIST_FAILS: options.listFails ? '1' : '0',
    LOCK_SHIM_OMIT_LOCKFILE: options.omitLockfile ? '1' : '0',
    PATH: [shim, process.env.PATH ?? dirname(process.execPath)].join(delimiter),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('handwritten pack lock generation', () => {
  it('generates a deterministic valid lock for an empty-plugin pack without dsh', async () => {
    const root = await makePack();

    const first = await generateAndWriteLock(root);
    const firstBytes = await readFile(join(root, 'pack.lock.yml'), 'utf8');
    const second = await generateAndWriteLock(root);
    const secondBytes = await readFile(join(root, 'pack.lock.yml'), 'utf8');

    expect(first).toMatchObject({ exitCode: 0, diagnostics: [] });
    expect(second).toMatchObject({ exitCode: 0, diagnostics: [] });
    expect(firstBytes).toBe(secondBytes);
    expect(firstBytes).toContain('generatedAt: 1970-01-01T00:00:00Z');
    expect(firstBytes).toContain('plugins: []');
  });

  it('retains a schema-valid existing generatedAt so repeated runs remain byte-identical', async () => {
    const root = await makePack();
    await generateAndWriteLock(root);
    const lockPath = join(root, 'pack.lock.yml');
    const generated = await readFile(lockPath, 'utf8');
    await writeFile(
      lockPath,
      generated.replace('1970-01-01T00:00:00Z', '2024-02-03T04:05:06Z'),
      'utf8',
    );

    const first = await generateAndWriteLock(root);
    const firstBytes = await readFile(lockPath, 'utf8');
    const second = await generateAndWriteLock(root);
    const secondBytes = await readFile(lockPath, 'utf8');

    expect(first).toMatchObject({ exitCode: 0, diagnostics: [] });
    expect(second).toMatchObject({ exitCode: 0, diagnostics: [] });
    expect(firstBytes).toContain('generatedAt: 2024-02-03T04:05:06Z');
    expect(firstBytes).toBe(secondBytes);
  });

  it('fails without writing a lock when an installed plugin lacks package facts', async () => {
    const root = await makePack([
      { name: 'fixture-bundle', source: { kind: 'npm', range: '1.0.0' }, allowBuilds: false },
    ]);
    const dshHome = join(root, '.isolated-home');
    const env = await writeDshShim(await temporary());

    const result = await generateAndWriteLock(root, { dshHome, env });

    expect(result).toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_LOCK_PACKAGE_FACTS' })],
    });
    await expect(readFile(join(root, 'pack.lock.yml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('records integrity and package facts only after the isolated dsh install has created them', async () => {
    const root = await makePack([
      { name: 'fixture-bundle', source: { kind: 'npm', range: '1.0.0' }, allowBuilds: false },
    ]);
    const dshHome = join(root, '.isolated-home');
    const env = await writeDshShim(await temporary(), { installPackage: true });

    const result = await generateLock(root, { dshHome, env });

    expect(result).toMatchObject({
      exitCode: 0,
      diagnostics: [],
      lockText: expect.stringContaining('packageJsonSha512: sha512-'),
    });
    expect(result.lockText).toContain('bundlePatch: ./cordis.patch.yml');
    expect(result.lockText).toContain('kind: npm-sri');
  });

  it('keeps pure generation byte-identical for the same empty-plugin input', async () => {
    const root = await makePack();

    const first = await generateLock(root);
    const second = await generateLock(root);

    expect(first).toMatchObject({ exitCode: 0, diagnostics: [] });
    expect(second).toMatchObject({ exitCode: 0, diagnostics: [] });
    expect(first.lockText).toBe(second.lockText);
  });

  it('stops at strict pack validation before collecting semantic files', async () => {
    const root = await temporary();

    const result = await generateLock(root);

    expect(result.exitCode).not.toBe(0);
    expect(result.lockText).toBeUndefined();
    expect(result.diagnostics).not.toEqual([]);
  });

  it('does not hide a non-ENOENT error while reading the previous lock', async () => {
    const root = await makePack();
    await mkdir(join(root, 'pack.lock.yml'));

    await expect(generateLock(root)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('rejects an explicit isolated DSH_HOME outside a plugin pack before spawning dsh', async () => {
    const root = await makePack([
      { name: 'fixture-bundle', source: { kind: 'npm', range: '1.0.0' }, allowBuilds: false },
    ]);
    const outsideHome = join(await temporary(), 'outside-home');

    await expect(generateLock(root, { dshHome: outsideHome })).resolves.toMatchObject({
      exitCode: 30,
      diagnostics: [expect.objectContaining({ code: 'E_LOCK_TEMP_HOME' })],
    });
  });

  it.each([
    ['profile initialization', { listFails: true }, 'E_LOCK_DSH'],
    ['plugin installation', { addFails: true }, 'E_LOCK_DSH'],
    ['missing pnpm lockfile', { omitLockfile: true }, 'E_NO_LOCK'],
  ] as const)('reports a %s failure without writing a lock', async (_name, shimOptions, code) => {
    const root = await makePack([
      { name: 'fixture-bundle', source: { kind: 'npm', range: '1.0.0' }, allowBuilds: false },
    ]);
    const env = await writeDshShim(await temporary(), shimOptions);

    const result = await generateAndWriteLock(root, { dshHome: join(root, '.isolated-home'), env });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
    expect(result.metadata.written).toBe(false);
    await expect(readFile(join(root, 'pack.lock.yml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses the deterministic timestamp when an existing lock cannot be parsed', async () => {
    const root = await makePack();
    await writeFile(join(root, 'pack.lock.yml'), 'not: [valid\n', 'utf8');

    const result = await generateLock(root);

    expect(result).toMatchObject({ exitCode: 0, diagnostics: [] });
    expect(result.lockText).toContain('generatedAt: 1970-01-01T00:00:00Z');
  });

  it('skips ignored dependency trees while collecting semantic pack files', async () => {
    const root = await makePack();
    await mkdir(join(root, 'node_modules', 'untrusted'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'untrusted', 'package.json'),
      '{not yaml}\n',
      'utf8',
    );

    const result = await generateLock(root);

    expect(result).toMatchObject({ exitCode: 0, diagnostics: [] });
    expect(result.lockText).not.toContain('node_modules');
  });

  it('uses the process environment only when no environment override is supplied', async () => {
    const root = await makePack([
      { name: 'fixture-bundle', source: { kind: 'npm', range: '1.0.0' }, allowBuilds: false },
    ]);
    const shimEnvironment = await writeDshShim(await temporary());
    const originalPath = process.env.PATH;
    process.env.PATH = shimEnvironment.PATH;
    try {
      const result = await generateLock(root, { dshHome: join(root, '.isolated-home') });
      expect(result).toMatchObject({
        exitCode: 30,
        diagnostics: [expect.objectContaining({ code: 'E_LOCK_PACKAGE_FACTS' })],
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('cleans its generated in-pack temporary DSH_HOME after a plugin lock attempt', async () => {
    const root = await makePack([
      { name: 'fixture-bundle', source: { kind: 'npm', range: '1.0.0' }, allowBuilds: false },
    ]);
    const env = await writeDshShim(await temporary());

    await generateLock(root, { env });

    expect((await readdir(root)).filter((name) => name.startsWith('.dshpack-lock-'))).toEqual([]);
  });

  it('passes github and tarball source specs to dsh unchanged', async () => {
    const githubRoot = await makePack([
      {
        name: 'fixture-bundle',
        source: {
          kind: 'github',
          owner: 'example',
          repo: 'fixture-bundle',
          ref: '0123456789012345678901234567890123456789',
        },
        allowBuilds: false,
      },
    ]);
    const tarballRoot = await makePack([
      {
        name: 'fixture-bundle',
        source: { kind: 'tarball', url: 'https://example.test/fixture-bundle-1.0.0.tgz' },
        allowBuilds: false,
      },
    ]);
    const argsFile = join(await temporary(), 'dsh-args.jsonl');
    const env = await writeDshShim(await temporary(), { argsFile });

    await generateLock(githubRoot, { dshHome: join(githubRoot, '.isolated-home'), env });
    await generateLock(tarballRoot, { dshHome: join(tarballRoot, '.isolated-home'), env });

    const invocations = await readFile(argsFile, 'utf8');
    expect(invocations).toContain(
      'github:example/fixture-bundle#0123456789012345678901234567890123456789',
    );
    expect(invocations).toContain('https://example.test/fixture-bundle-1.0.0.tgz');
  });
});
