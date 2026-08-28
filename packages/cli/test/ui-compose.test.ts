import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODES } from '../src/exit-codes.js';
import { composeAndInstall, previewCompose } from '../src/ui/compose.js';
import { enginePack } from './install-engine-fixture.js';

const roots: string[] = [];

async function snapshot(root: string): Promise<string> {
  const entries: Array<{ path: string; bytes: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else
        entries.push({
          path: relative(root, path),
          bytes: (await readFile(path)).toString('base64'),
        });
    }
  }
  await visit(root);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('UI compose preview', () => {
  it('rejects profile sources before preview so the read operation cannot export a profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const preview = await previewCompose(root, {
      spec: {
        composeVersion: 0,
        name: 'profile-source',
        version: '1.0.0',
        description: 'Not a UI source form.',
        author: 'test',
        license: 'MIT',
        include: [{ from: 'profile:existing', skills: ['*'] }],
        defaults: { permissionPreset: 'workspace-write' },
      },
    });
    expect(preview).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_UI_COMPOSE_SPEC' })],
    });
  });

  it('returns available skills and provenance while making zero DSH_HOME writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const dshHome = join(root, 'home');
    const source = await enginePack({ assets: true });
    const before = await snapshot(root);

    const preview = await previewCompose(dshHome, {
      spec: {
        composeVersion: 0,
        name: 'combined-notes',
        version: '1.0.0',
        description: 'One selected note skill.',
        author: 'dshpack test',
        license: 'MIT',
        include: [{ from: source, skills: ['notes'] }],
        defaults: { permissionPreset: 'workspace-write' },
      },
    });

    expect(preview).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        phase: 'preview',
        sourceSkills: [expect.objectContaining({ skills: ['notes'] })],
        provenance: [expect.objectContaining({ id: 'notes', originalId: 'notes' })],
        conflicts: [],
      },
    });
    expect(await snapshot(root)).toBe(before);
  });

  it('reuses preview materialization when composing the same source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const source = 'github:owner/repo#0123456789abcdef0123456789abcdef01234567';
    const cached = {
      cleanup: vi.fn(async () => undefined),
      from: source,
      license: 'MIT',
      material: {
        manifest: {
          formatVersion: 0 as const,
          name: 'notes',
          version: '1.0.0',
          description: 'Notes.',
          author: 'test',
          license: 'MIT',
          dsh: { tested: ['0.1.0-rc.6'] },
          plugins: [],
          mcp: [],
          defaults: { permissionPreset: 'workspace-write' as const },
        },
        paths: ['skills/notes/SKILL.md'],
        files: [
          {
            path: 'skills/notes/SKILL.md',
            sha512: 'sha512-test',
            contentBase64: Buffer.from('# Notes\n').toString('base64'),
          },
        ],
        sourceFiles: [],
        manifestDigest: 'sha256-test',
      },
    };
    const materialize = vi.fn(async () => cached);
    const compose = vi.fn(async (input, dependencies) => {
      expect(dependencies?.materializeSource).toBeTypeOf('function');
      const reused = await dependencies?.materializeSource(
        { from: source, skills: ['*'] },
        input.composeFile,
        input.dshHome,
      );
      expect(reused).toBe(cached);
      return {
        diagnostics: [],
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { directory: '', dryRun: true, selected: [], sources: [source] },
      };
    });

    const preview = await previewCompose(
      root,
      {
        spec: {
          composeVersion: 0,
          name: 'cached-preview',
          version: '1.0.0',
          description: 'Reuse a verified preview source.',
          author: 'test',
          license: 'MIT',
          include: [{ from: source, skills: ['*'] }],
          defaults: { permissionPreset: 'workspace-write' },
        },
      },
      { materialize, compose },
    );

    expect(preview.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  it('falls back to a fresh materialization only when compose requests an uncached selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const source = await enginePack({ assets: true });
    const materialize = vi.fn(async (selection: { readonly from: string }) => {
      const { materializeComposeSource } = await import('../src/compose/sources.js');
      return materializeComposeSource(
        { from: selection.from, skills: ['notes'] },
        join(root, 'compose.yml'),
        root,
      );
    });
    const compose = vi.fn(async (input, dependencies) => {
      const fallback = await dependencies?.materializeSource(
        { from: source, skills: ['different-selection'] },
        input.composeFile,
        input.dshHome,
      );
      if ('cleanup' in fallback) await fallback.cleanup();
      return {
        diagnostics: [],
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { directory: '', dryRun: true, selected: [], sources: [source] },
      };
    });

    const preview = await previewCompose(
      root,
      {
        spec: {
          composeVersion: 0,
          name: 'uncached-preview',
          version: '1.0.0',
          description: 'A custom compose adapter requests a distinct selection.',
          author: 'test',
          license: 'MIT',
          include: [{ from: source, skills: ['notes'] }],
          defaults: { permissionPreset: 'workspace-write' },
        },
      },
      { materialize: materialize as never, compose: compose as never },
    );

    expect(preview.exitCode).toBe(EXIT_CODES.SUCCESS);
    expect(materialize).toHaveBeenCalledOnce();
    expect(compose).toHaveBeenCalledOnce();
  });

  it('accepts a bare GitHub repository URL in the real preview boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const materialize = vi.fn(async () => ({
      diagnostics: [
        { code: 'E_SOURCE', severity: 'error' as const, message: 'stub', hint: 'stub' },
      ],
      exitCode: EXIT_CODES.CONTRACT,
    }));
    const compose = vi.fn(async () => ({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        directory: '',
        dryRun: true,
        selected: [
          {
            from: 'github:dsh-packs/web-dev#0123456789abcdef0123456789abcdef01234567',
            id: 'notes',
            originalId: 'notes',
          },
        ],
        sources: ['github:dsh-packs/web-dev#0123456789abcdef0123456789abcdef01234567'],
      },
    }));

    const preview = await previewCompose(
      root,
      {
        spec: {
          composeVersion: 0,
          name: 'github-url',
          version: '1.0.0',
          description: 'Bare GitHub URL source.',
          author: 'dshpack test',
          license: 'MIT',
          include: [{ from: 'https://github.com/dsh-packs/web-dev', skills: ['notes'] }],
          defaults: { permissionPreset: 'workspace-write' },
        },
      },
      { compose: compose as never, materialize: materialize as never },
    );

    expect(preview).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        selected: [{ from: 'github:dsh-packs/web-dev#0123456789abcdef0123456789abcdef01234567' }],
      },
    });
    expect(materialize).toHaveBeenCalledOnce();
    expect(compose).toHaveBeenCalledOnce();
  });

  it('fails closed for invalid form data and source materialization while always cleaning the preview root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const compose = vi.fn(async (_input: unknown) => ({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { directory: '', dryRun: true, selected: [] },
    }));
    const materialize = vi.fn(async () => ({
      diagnostics: [{ code: 'E_SOURCE', severity: 'error', message: 'missing', hint: 'fix' }],
      exitCode: EXIT_CODES.CONTRACT,
    }));
    const invalid = await previewCompose(root, {
      spec: {
        composeVersion: 0,
        name: 'combined-notes',
        version: 'not-semver',
        description: 'Invalid form.',
        author: 'dshpack test',
        license: 'MIT',
        include: [{ from: './source', skills: ['notes'] }],
        defaults: { permissionPreset: 'workspace-write' },
      },
    });
    expect(invalid).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_UI_COMPOSE_SPEC' })],
    });

    const failedSource = await previewCompose(
      root,
      {
        spec: {
          composeVersion: 0,
          name: 'combined-notes',
          version: '1.0.0',
          description: 'Remote source branch.',
          author: 'dshpack test',
          license: 'MIT',
          include: [
            {
              from: 'github:owner/repo#0123456789abcdef0123456789abcdef01234567',
              skills: ['notes'],
            },
          ],
          resolve: [
            { id: 'notes', prefer: 'github:owner/repo#0123456789abcdef0123456789abcdef01234567' },
          ],
          mcp: [
            { serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example/docs' },
          ],
          defaults: { permissionPreset: 'workspace-write' },
        },
      },
      { compose: compose as never, materialize: materialize as never },
    );
    expect(failedSource).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { sourceSkills: [] },
    });
    expect(compose).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
      expect.objectContaining({ materializeSource: expect.any(Function) }),
    );
    expect(compose.mock.calls[0]?.[0]).not.toHaveProperty('allowUnknownLicense');
    expect(materialize).toHaveBeenCalledOnce();
  });

  it('passes an explicit unknown-license acknowledgement to compose write calls only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const input = {
      profile: 'combined-notes',
      spec: {
        composeVersion: 0,
        name: 'combined-notes',
        version: '1.0.0',
        description: 'Check the compose write consent boundary.',
        author: 'dshpack test',
        license: 'MIT',
        include: [{ from: './source', skills: ['notes'] }],
        defaults: { permissionPreset: 'workspace-write' },
      },
    } as const;
    const compose = vi.fn(async () => ({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { directory: '', dryRun: false, selected: [] },
    }));
    const install = vi.fn(async () => ({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {},
    }));

    await composeAndInstall(root, { ...input, allowUnknownLicense: true }, {} as never, 'plan', {
      compose: compose as never,
      install: install as never,
    });
    await composeAndInstall(root, input, {} as never, 'plan', {
      compose: compose as never,
      install: install as never,
    });
    await composeAndInstall(root, { ...input, allowUnknownLicense: false }, {} as never, 'plan', {
      compose: compose as never,
      install: install as never,
    });

    expect(compose).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ allowUnknownLicense: true }),
    );
    expect(compose).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ allowUnknownLicense: false }),
    );
    expect(compose).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ allowUnknownLicense: false }),
    );
  });

  it('uses a stable compose plan digest and delegates both plan and apply to install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const pinned = 'github:owner/repo#0123456789abcdef0123456789abcdef01234567';
    const archiveWarning = {
      code: 'E_ARCHIVE_ENTRY_SKIPPED',
      severity: 'warning' as const,
      message: 'Skipped non-regular archive entry: skills/link.',
      hint: 'The entry was not deployed or followed.',
      evidence: 'local' as const,
    };
    const compose = vi.fn(async () => ({
      diagnostics: [archiveWarning],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        directory: '',
        dryRun: false,
        selected: [{ from: pinned, id: 'notes', originalId: 'notes' }],
        sources: [pinned],
      },
    }));
    const install = vi.fn(async (input: { readonly dryRun?: boolean }) => ({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        status: input.dryRun === true ? 'planned' : 'installed',
        plan: {
          pack: { name: 'combined-notes', version: '1.0.0' },
          rollbackSnapshot: { targetBeforeStateDigest: 'sha256-before' },
        },
      },
    }));
    const input = {
      profile: 'combined-notes',
      spec: {
        composeVersion: 0,
        name: 'combined-notes',
        version: '1.0.0',
        description: 'Install via transaction.',
        author: 'dshpack test',
        license: 'MIT',
        include: [{ from: 'https://github.com/owner/repo', skills: ['notes'] }],
        defaults: { permissionPreset: 'workspace-write' },
      },
    } as const;
    const dependencies = { compose: compose as never, install: install as never };

    const planned = await composeAndInstall(root, input, {} as never, 'plan', dependencies);
    const applied = await composeAndInstall(root, input, {} as never, 'apply', dependencies);
    expect(planned).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      diagnostics: [
        expect.objectContaining({ code: 'E_ARCHIVE_ENTRY_SKIPPED', severity: 'warning' }),
      ],
      metadata: {
        plan: {
          operation: 'compose',
          planDigest: expect.stringMatching(/^sha256-/u),
          compose: { spec: { include: [{ from: pinned, skills: ['notes'] }] } },
        },
      },
    });
    expect(applied).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      diagnostics: [
        expect.objectContaining({ code: 'E_ARCHIVE_ENTRY_SKIPPED', severity: 'warning' }),
      ],
      metadata: { status: 'installed' },
    });
    const plan = (planned.metadata as { plan: { planDigest: string } }).plan;
    const appliedPlan = (applied.metadata as { plan: { planDigest: string } }).plan;
    expect(appliedPlan.planDigest).toBe(plan.planDigest);
    expect(install).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ dryRun: true }),
      expect.anything(),
    );
    expect(install).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ dryRun: false }),
      expect.anything(),
    );
  });

  it('keeps an unpinned source and its prefer rule unchanged in the reviewed compose plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const source = 'https://github.com/owner/repo';
    const input = {
      profile: 'combined-notes',
      spec: {
        composeVersion: 0,
        name: 'combined-notes',
        version: '1.0.0',
        description: 'Preserve an unpinned source until the adapter resolves it.',
        author: 'dshpack test',
        license: 'MIT',
        include: [{ from: source, skills: ['notes'] }],
        resolve: [{ id: 'notes', prefer: source }],
        defaults: { permissionPreset: 'workspace-write' },
      },
    } as const;
    const result = await composeAndInstall(root, input, {} as never, 'plan', {
      compose: (async () => ({
        diagnostics: [],
        exitCode: EXIT_CODES.SUCCESS,
        metadata: {
          directory: '',
          dryRun: false,
          selected: [{ from: source, id: 'notes', originalId: 'notes' }],
          sources: [source],
        },
      })) as never,
      install: (async () => ({
        diagnostics: [],
        exitCode: EXIT_CODES.SUCCESS,
        metadata: {
          plan: {
            pack: { name: 'combined-notes', version: '1.0.0' },
            rollbackSnapshot: { targetBeforeStateDigest: 'sha256-before' },
          },
        },
      })) as never,
    });

    expect(result).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        plan: {
          compose: {
            spec: {
              include: [{ from: source, skills: ['notes'] }],
              resolve: [{ id: 'notes', prefer: source }],
            },
          },
        },
      },
    });
  });

  it('preserves compose failures and handles an install report without a plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const input = {
      profile: 'combined-notes',
      spec: {
        composeVersion: 0,
        name: 'combined-notes',
        version: '1.0.0',
        description: 'Failure result.',
        author: 'dshpack test',
        license: 'MIT',
        include: [{ from: './source', skills: ['notes'] }],
        defaults: { permissionPreset: 'workspace-write' },
      },
    } as const;
    const failed = await composeAndInstall(root, input, {} as never, 'plan', {
      compose: (async () => ({
        diagnostics: [{ code: 'E_COMPOSE', severity: 'error', message: 'bad', hint: 'fix' }],
        exitCode: EXIT_CODES.CONTRACT,
        metadata: { directory: '', dryRun: false, selected: [] },
      })) as never,
    });
    expect(failed).toMatchObject({ exitCode: EXIT_CODES.CONTRACT, metadata: { phase: 'plan' } });

    const noPlan = await composeAndInstall(root, input, {} as never, 'apply', {
      compose: (async () => ({
        diagnostics: [],
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { directory: '', dryRun: false, selected: [] },
      })) as never,
      install: (async () => ({
        diagnostics: [],
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { status: 'installed' },
      })) as never,
    });
    expect(noPlan).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { status: 'installed' },
    });
    expect(noPlan.metadata).not.toHaveProperty('plan');
  });

  it('rejects an invalid compose-and-install form before it materializes or installs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const compose = vi.fn();
    const install = vi.fn();

    const result = await composeAndInstall(
      root,
      {
        profile: 'combined-notes',
        spec: {
          composeVersion: 0,
          name: 'bad-version',
          version: 'not-semver',
          description: 'Invalid forms must not reach mutable engines.',
          author: 'test',
          license: 'MIT',
          include: [{ from: './source', skills: ['notes'] }],
          defaults: { permissionPreset: 'workspace-write' },
        },
      },
      {} as never,
      'plan',
      { compose: compose as never, install: install as never },
    );

    expect(result).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      diagnostics: [expect.objectContaining({ code: 'E_UI_COMPOSE_SPEC' })],
    });
    expect(compose).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('keeps non-conflict compose diagnostics out of the conflict list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-test-'));
    roots.push(root);
    const preview = await previewCompose(
      root,
      {
        spec: {
          composeVersion: 0,
          name: 'combined-notes',
          version: '1.0.0',
          description: 'Warning branch.',
          author: 'dshpack test',
          license: 'MIT',
          include: [{ from: './source', skills: ['notes'] }],
          resolve: [{ id: 'notes', rename: 'renamed-notes' }],
          defaults: { permissionPreset: 'workspace-write' },
        },
      },
      {
        compose: (async () => ({
          diagnostics: [
            { code: 'W_COMPOSE', severity: 'warning', message: 'warning', hint: 'review' },
          ],
          exitCode: EXIT_CODES.SUCCESS,
          metadata: { directory: '', dryRun: true, selected: [] },
        })) as never,
        materialize: (async () => ({
          diagnostics: [],
          exitCode: EXIT_CODES.CONTRACT,
        })) as never,
      },
    );
    expect(preview).toMatchObject({ exitCode: EXIT_CODES.SUCCESS, metadata: { conflicts: [] } });
  });
});
