import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Diagnostic } from '@dshpack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODES } from '../src/exit-codes.js';
import { createNodeInstallRuntime } from '../src/install/runtime.js';
import {
  promptAuthorized,
  startUiServer,
  type UiServerEngineRegistry,
  type UiServerWriteInvocation,
} from '../src/ui/server.js';
import { enginePack } from './install-engine-fixture.js';

type JsonObject = Record<string, unknown>;

const temporaryRoots: string[] = [];

async function temporaryHome(secret = 'ui-server-fixture'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-server-'));
  temporaryRoots.push(root);
  const home = join(root, secret);
  await mkdir(home);
  return home;
}

async function temporaryUiAssets(): Promise<{ index: URL; app: URL }> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-assets-'));
  temporaryRoots.push(root);
  const index = join(root, 'index.html');
  const app = join(root, 'app.js');
  await writeFile(
    index,
    '<!doctype html><html><body><script src="/ui/app.js?token=__DSHPACK_UI_TOKEN__"></script></body></html>',
  );
  await writeFile(app, 'globalThis.dshpackUiFixture = true;');
  return { index: pathToFileURL(index), app: pathToFileURL(app) };
}

async function missingUiAssets(): Promise<{ index: URL; app: URL }> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-missing-assets-'));
  temporaryRoots.push(root);
  return {
    index: pathToFileURL(join(root, 'index.html')),
    app: pathToFileURL(join(root, 'app.js')),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function report(metadata: JsonObject = {}, diagnostics: readonly Diagnostic[] = []) {
  return { diagnostics, exitCode: EXIT_CODES.SUCCESS, metadata };
}

function inertEngines(overrides: Partial<UiServerEngineRegistry> = {}): UiServerEngineRegistry {
  return {
    runRead: async ({ operation }) => report({ operation }),
    runWrite: async ({ operation, phase }) => report({ operation, phase, plan: { operation } }),
    ...overrides,
  };
}

async function post(
  origin: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${origin}/api`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as JsonObject };
}

async function getStatic(
  target: string,
  token?: string,
): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(target, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function origin(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

async function chunkedPost(
  target: string,
  token: string,
  chunks: readonly string[],
): Promise<{ status: number; body: JsonObject }> {
  return new Promise((resolveNow, reject) => {
    const parsed = new URL(target);
    const request = httpRequest(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: '/api',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      },
      (response) => {
        const received: Buffer[] = [];
        response.on('data', (chunk: Buffer) => received.push(chunk));
        response.on('end', () => {
          resolveNow({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(received).toString('utf8')) as JsonObject,
          });
        });
      },
    );
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function byteSnapshot(root: string): Promise<string> {
  const entries: Array<{ path: string; bytes: string }> = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else
        entries.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: (await readFile(path)).toString('base64'),
        });
    }
  }
  await visit(root);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

describe('UI HTTP server trust boundary', () => {
  it('binds the real socket to IPv4 loopback and mints a fresh token per server', async () => {
    const dshHome = await temporaryHome();
    const first = await startUiServer({ dshHome, port: 0, engines: inertEngines() });
    const second = await startUiServer({ dshHome, port: 0, engines: inertEngines() });
    try {
      expect(first.server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
      expect(second.server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
      expect(first.url).toBe(`http://127.0.0.1:${first.port}/?token=${first.token}`);
      expect(first.token).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
      expect(second.token).not.toBe(first.token);
    } finally {
      await first.close();
      await first.close();
      await second.close();
    }
  });

  it('accepts only POST /api and verifies a bearer or URL token on every request', async () => {
    const dshHome = await temporaryHome();
    const engines = inertEngines({ runRead: vi.fn(async () => report({ ok: true })) });
    const handle = await startUiServer({ dshHome, engines });
    const base = origin(handle.url);
    try {
      for (const supplied of [undefined, 'wrong-token']) {
        const denied = await post(base, { operation: 'list', input: {} }, supplied);
        expect(denied.status).toBe(401);
        expect(denied.body).toMatchObject({
          exitCode: EXIT_CODES.SECURITY,
          diagnostics: [expect.objectContaining({ code: 'E_UI_AUTH' })],
        });
        expect(JSON.stringify(denied.body)).not.toContain(handle.token);
      }

      const wrongMethod = await fetch(`${base}/api`, {
        headers: { authorization: `Bearer ${handle.token}` },
      });
      expect(wrongMethod.status).toBe(405);
      const wrongPath = await fetch(`${base}/other`, {
        method: 'POST',
        headers: { authorization: `Bearer ${handle.token}` },
      });
      expect(wrongPath.status).toBe(404);

      const bearer = await post(base, { operation: 'list', input: {} }, handle.token);
      expect(bearer).toMatchObject({ status: 200, body: { exitCode: EXIT_CODES.SUCCESS } });
      const urlToken = await fetch(`${base}/api?token=${encodeURIComponent(handle.token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'list', input: {} }),
      });
      expect(urlToken.status).toBe(200);
      expect(engines.runRead).toHaveBeenCalledTimes(2);
    } finally {
      await handle.close();
    }
  });

  it('authenticates static requests before attempting to read their assets', async () => {
    const dshHome = await temporaryHome();
    const handle = await startUiServer({
      dshHome,
      engines: inertEngines(),
      uiAssets: await missingUiAssets(),
    });
    const base = origin(handle.url);
    try {
      for (const path of ['/', '/ui/app.js']) {
        expect((await getStatic(`${base}${path}`)).status).toBe(401);
        expect((await getStatic(`${base}${path}?token=wrong-token`)).status).toBe(401);
      }
    } finally {
      await handle.close();
    }
  });

  it('serves only the token-protected UI document and app asset with no-store security headers', async () => {
    const dshHome = await temporaryHome();
    const handle = await startUiServer({
      dshHome,
      engines: inertEngines(),
      uiAssets: await temporaryUiAssets(),
    });
    const base = origin(handle.url);
    try {
      for (const path of ['/', '/ui/app.js']) {
        for (const supplied of [undefined, 'wrong-token']) {
          const query = supplied === undefined ? '' : `?token=${supplied}`;
          const denied = await getStatic(`${base}${path}${query}`);
          expect(denied.status, `${path} with ${supplied ?? 'no'} URL token`).toBe(401);
          expect(denied.headers.get('referrer-policy')).toBe('no-referrer');
          expect(denied.headers.get('cache-control')).toBe('no-store');
          expect(denied.headers.get('x-content-type-options')).toBe('nosniff');
          expect(denied.text).not.toContain(handle.token);
        }
      }

      const page = await getStatic(`${base}/?token=${encodeURIComponent(handle.token)}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/^text\/html;\s*charset=utf-8$/u);
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(page.text).toContain(`/ui/app.js?token=${encodeURIComponent(handle.token)}`);
      expect(page.text).not.toContain('__DSHPACK_UI_TOKEN__');

      const app = await getStatic(`${base}/ui/app.js?token=${encodeURIComponent(handle.token)}`);
      expect(app.status).toBe(200);
      expect(app.headers.get('content-type')).toMatch(
        /^(?:text|application)\/javascript;\s*charset=utf-8$/u,
      );
      expect(app.headers.get('referrer-policy')).toBe('no-referrer');
      expect(app.headers.get('cache-control')).toBe('no-store');
      expect(app.headers.get('x-content-type-options')).toBe('nosniff');
      expect(app.text.length).toBeGreaterThan(0);

      const unknown = await getStatic(
        `${base}/ui/not-a-real-asset?token=${encodeURIComponent(handle.token)}`,
        handle.token,
      );
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('referrer-policy')).toBe('no-referrer');
      expect(unknown.headers.get('cache-control')).toBe('no-store');
      expect(unknown.headers.get('x-content-type-options')).toBe('nosniff');

      const wrongMethod = await fetch(
        `${base}/ui/app.js?token=${encodeURIComponent(handle.token)}`,
        {
          method: 'POST',
          body: 'ignored',
        },
      );
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get('referrer-policy')).toBe('no-referrer');
      expect(wrongMethod.headers.get('cache-control')).toBe('no-store');
      expect(wrongMethod.headers.get('x-content-type-options')).toBe('nosniff');

      const api = await post(base, { operation: 'list', input: {} }, handle.token);
      expect(api).toMatchObject({ status: 200, body: { exitCode: EXIT_CODES.SUCCESS } });
    } finally {
      await handle.close();
    }
  });

  it('rejects malformed, oversized, boolean-consent, and yes-bearing requests before dispatch', async () => {
    const dshHome = await temporaryHome();
    const engines = inertEngines({ runWrite: vi.fn(inertEngines().runWrite) });
    const handle = await startUiServer({ dshHome, engines, maxBodyBytes: 160 });
    const base = origin(handle.url);
    try {
      const malformed = await fetch(`${base}/api`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.token}`,
          'content-type': 'application/json',
        },
        body: '{',
      });
      expect(malformed.status).toBe(400);

      const oversized = await fetch(`${base}/api`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ operation: 'list', input: { value: 'x'.repeat(256) } }),
      });
      expect(oversized.status).toBe(413);

      const chunked = await chunkedPost(base, handle.token, [
        '{"operation":"list","input":{"value":"',
        'x'.repeat(256),
        '"}}',
      ]);
      expect(chunked.status).toBe(413);

      for (const body of [
        null,
        { operation: 'unknown', input: {} },
        { operation: 'list', input: {}, phase: 'plan' },
        { operation: 'gc', phase: 'invalid', input: {}, authorizedDangerousPermissions: [] },
        {
          operation: 'gc',
          phase: 'plan',
          input: {},
          authorizedDangerousPermissions: [],
          planDigest: 'sha256-not-allowed',
        },
        { operation: 'gc', phase: 'apply', input: {}, authorizedDangerousPermissions: [] },
        {
          operation: 'gc',
          phase: 'plan',
          input: {},
          authorizedDangerousPermissions: [{ kind: 'unknown', subject: 'fixture' }],
        },
        {
          operation: 'gc',
          phase: 'plan',
          input: {},
          authorizedDangerousPermissions: [null],
        },
        {
          operation: 'gc',
          phase: 'plan',
          input: {},
          authorizedDangerousPermissions: [
            { kind: 'version-mismatch', subject: '1.0.0', tested: [false] },
          ],
        },
        {
          operation: 'gc',
          phase: 'plan',
          input: {},
          authorizedDangerousPermissions: true,
        },
        {
          operation: 'gc',
          phase: 'apply',
          input: { yes: true },
          authorizedDangerousPermissions: [],
          planDigest: 'sha256-invalid',
        },
      ]) {
        const denied = await post(base, body, handle.token);
        expect(denied.status).toBe(400);
        expect(denied.body).toMatchObject({ exitCode: EXIT_CODES.USAGE });
      }
      expect(engines.runWrite).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('accepts each structured permission kind and deduplicates exact items', async () => {
    const dshHome = await temporaryHome();
    const permissions = [
      { kind: 'allow-build', subject: 'plugin-a' },
      { kind: 'danger-full-access', subject: 'danger-full-access' },
      { kind: 'unverified-source', subject: 'plugin-a' },
      { kind: 'new-plugin', subject: 'plugin-a', identity: 'identity-a' },
      { kind: 'version-mismatch', subject: '1.0.0', tested: ['2.0.0'] },
      { kind: 'force', subject: 'fixture' },
      { kind: 'purge-generations', subject: 'fixture' },
    ] as const;
    const engines = inertEngines({
      runWrite: async () => report({ requiredDangerousPermissions: permissions, plan: {} }),
    });
    const handle = await startUiServer({ dshHome, engines });
    try {
      const response = await post(
        origin(handle.url),
        {
          operation: 'gc',
          phase: 'plan',
          input: {},
          authorizedDangerousPermissions: [...permissions, permissions[0]],
        },
        handle.token,
      );
      expect(response.body).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { authorizedDangerousPermissions: permissions },
      });
    } finally {
      await handle.close();
    }
  });

  it('dispatches the default direct-engine registry without constructing argv', async () => {
    const dshHome = await temporaryHome();
    const handle = await startUiServer({
      dshHome,
      runtime: createNodeInstallRuntime(dshHome),
    });
    const base = origin(handle.url);
    try {
      for (const request of [
        { operation: 'list', input: {} },
        { operation: 'status', input: {} },
        { operation: 'diff', input: { profile: 'invalid-profile' } },
        { operation: 'doctor', input: {} },
      ]) {
        const response = await post(base, request, handle.token);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ diagnostics: expect.any(Array) });
      }

      for (const request of [
        {
          operation: 'install',
          phase: 'plan',
          input: { source: join(dshHome, 'missing-pack') },
          authorizedDangerousPermissions: [],
        },
        {
          operation: 'uninstall',
          phase: 'plan',
          input: { profile: 'invalid-profile' },
          authorizedDangerousPermissions: [],
        },
        {
          operation: 'update',
          phase: 'plan',
          input: { profile: 'INVALID' },
          authorizedDangerousPermissions: [],
        },
        {
          operation: 'restore',
          phase: 'plan',
          input: { profile: 'invalid-profile' },
          authorizedDangerousPermissions: [],
        },
      ]) {
        const response = await post(base, request, handle.token);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ diagnostics: expect.any(Array) });
      }

      const planned = await post(
        base,
        { operation: 'gc', phase: 'plan', input: {}, authorizedDangerousPermissions: [] },
        handle.token,
      );
      expect(planned.body).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { planDigest: expect.any(String) },
      });
      const applied = await post(
        base,
        {
          operation: 'gc',
          phase: 'apply',
          input: {},
          authorizedDangerousPermissions: [],
          planDigest: (planned.body.metadata as JsonObject).planDigest,
        },
        handle.token,
      );
      expect(applied.body).toMatchObject({ exitCode: EXIT_CODES.SUCCESS });
    } finally {
      await handle.close();
    }
  });

  it('dispatches every read operation without changing a byte and redacts credential fragments', async () => {
    const secret = 'credential-0123456789-DO-NOT-ECHO';
    const independentCredential = 'sk-UI-SERVER-INDEPENDENT-0123456789';
    const dshHome = await temporaryHome(secret);
    await writeFile(join(dshHome, 'sentinel.bin'), Buffer.from([0, 1, 2, 3, 255]));
    const before = await byteSnapshot(dshHome);
    const calls: string[] = [];
    const engines = inertEngines({
      runRead: async ({ operation, input }) => {
        calls.push(operation);
        expect(input.dshHome).toBe(dshHome);
        return report({ operation }, [
          {
            code: 'E_INJECTED',
            severity: 'error',
            message: `failed at ${dshHome}; credential ${independentCredential}`,
            hint: `fragment ${secret.slice(6, 18)} and ${independentCredential.slice(0, 12)}`,
            path: join(dshHome, 'credential.txt'),
            evidence: 'local',
          },
        ]);
      },
    });
    const handle = await startUiServer({ dshHome, engines });
    try {
      for (const operation of ['list', 'status', 'diff', 'doctor'] as const) {
        const response = await post(
          origin(handle.url),
          { operation, input: operation === 'diff' ? { profile: 'fixture' } : {} },
          handle.token,
        );
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          diagnostics: [expect.objectContaining({ code: 'E_INJECTED' })],
        });
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain(independentCredential);
        for (let index = 0; index <= secret.length - 8; index += 1)
          expect(serialized).not.toContain(secret.slice(index, index + 8));
        for (let index = 0; index <= independentCredential.length - 8; index += 1)
          expect(serialized).not.toContain(independentCredential.slice(index, index + 8));
      }
      expect(calls).toEqual(['list', 'status', 'diff', 'doctor']);
      expect(await byteSnapshot(dshHome)).toBe(before);
    } finally {
      await handle.close();
    }
  });
});

describe('UI write plan/apply gateway', () => {
  const operations = ['install', 'uninstall', 'update', 'restore', 'gc'] as const;
  const required = [
    { kind: 'force', subject: 'fixture-profile' },
    { kind: 'purge-generations', subject: 'fixture-profile' },
  ] as const;

  function fixture() {
    let revision = 1;
    const calls: UiServerWriteInvocation[] = [];
    const engines = inertEngines({
      runWrite: async (invocation) => {
        calls.push(invocation);
        return report({
          operation: invocation.operation,
          plan: { operation: invocation.operation, revision },
          requiredDangerousPermissions: required,
          enginePhase: invocation.phase,
        });
      },
    });
    return { calls, engines, setRevision: (next: number) => (revision = next) };
  }

  it('derives every install permission from the plan and request instead of trusting metadata', async () => {
    const dshHome = await temporaryHome();
    const requiredInstallPermissions = [
      { kind: 'danger-full-access', subject: 'danger-full-access' },
      { kind: 'version-mismatch', subject: '1.0.0', tested: ['2.0.0'] },
      { kind: 'allow-build', subject: 'builder' },
      { kind: 'unverified-source', subject: 'builder' },
      { kind: 'allow-build', subject: 'fixture-profile' },
      { kind: 'force', subject: 'fixture-profile' },
    ] as const;
    const engines = inertEngines({
      runWrite: async () =>
        report({
          plan: {
            targetProfile: 'fixture-profile',
            requiredDangerousPermissions: ['danger-full-access'],
            dsh: { versionMismatch: true, current: '1.0.0', tested: ['2.0.0', 3] },
            plugins: [
              null,
              {
                name: 'builder',
                allowBuilds: true,
                integrity: { kind: 'unverified' },
              },
              { allowBuilds: true, integrity: { kind: 'npm-sri' } },
            ],
          },
        }),
    });
    const handle = await startUiServer({ dshHome, engines });
    try {
      const response = await post(
        origin(handle.url),
        {
          operation: 'install',
          phase: 'plan',
          input: { source: 'fixture-source', as: 'fixture-profile', force: true },
          authorizedDangerousPermissions: requiredInstallPermissions,
        },
        handle.token,
      );
      expect(response.body).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        metadata: {
          requiredDangerousPermissions: requiredInstallPermissions,
          missingDangerousPermissions: [],
        },
      });
    } finally {
      await handle.close();
    }
  });

  it('binds an existing engine plan digest while deriving force authorization from source input', async () => {
    const dshHome = await temporaryHome();
    const source = 'source-only-pack';
    const engines = inertEngines({
      runWrite: async () => report({ plan: { planDigest: 'sha256-engine-bound', plugins: [] } }),
    });
    const handle = await startUiServer({ dshHome, engines });
    try {
      const response = await post(
        origin(handle.url),
        {
          operation: 'install',
          phase: 'plan',
          input: { source, force: true },
          authorizedDangerousPermissions: [{ kind: 'force', subject: source }],
        },
        handle.token,
      );
      expect(response.body).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { planDigest: 'sha256-engine-bound', missingDangerousPermissions: [] },
      });

      const purged = await post(
        origin(handle.url),
        {
          operation: 'uninstall',
          phase: 'plan',
          input: { profile: 'fixture-profile', purgeGenerations: true },
          authorizedDangerousPermissions: [
            { kind: 'purge-generations', subject: 'fixture-profile' },
          ],
        },
        handle.token,
      );
      expect(purged.body).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { missingDangerousPermissions: [] },
      });
    } finally {
      await handle.close();
    }
  });

  it('pins a re-planned bare GitHub install source before apply', async () => {
    const dshHome = await temporaryHome();
    const calls: UiServerWriteInvocation[] = [];
    const pinned = 'github:owner/repo#0123456789abcdef0123456789abcdef01234567';
    const engines = inertEngines({
      runWrite: async (invocation) => {
        calls.push(invocation);
        return report({
          plan: {
            source: {
              kind: 'github',
              owner: 'owner',
              repo: 'repo',
              commit: '0123456789abcdef0123456789abcdef01234567',
              url: 'https://codeload.github.com/owner/repo/tar.gz/0123456789abcdef0123456789abcdef01234567',
            },
          },
        });
      },
    });
    const handle = await startUiServer({ dshHome, engines });
    try {
      const input = { source: 'https://github.com/owner/repo', as: 'target-profile' };
      const planned = await post(
        origin(handle.url),
        { operation: 'install', phase: 'plan', input, authorizedDangerousPermissions: [] },
        handle.token,
      );
      const planDigest = (planned.body.metadata as JsonObject).planDigest as string;
      const applied = await post(
        origin(handle.url),
        {
          operation: 'install',
          phase: 'apply',
          input,
          planDigest,
          authorizedDangerousPermissions: [],
        },
        handle.token,
      );

      expect(applied.status).toBe(200);
      expect(calls).toHaveLength(3);
      expect(calls[2]).toMatchObject({ phase: 'apply', input: { source: pinned } });
    } finally {
      await handle.close();
    }
  });

  it('uses the compose plan canonical spec for apply', async () => {
    const dshHome = await temporaryHome();
    const calls: UiServerWriteInvocation[] = [];
    const pinned = 'github:owner/repo#0123456789abcdef0123456789abcdef01234567';
    const canonicalSpec = {
      composeVersion: 0,
      name: 'target-profile',
      version: '1.0.0',
      description: 'Pinned source.',
      author: 'test',
      license: 'MIT',
      include: [{ from: pinned, skills: ['notes'] }],
      defaults: { permissionPreset: 'workspace-write' },
    };
    const engines = inertEngines({
      runWrite: async (invocation) => {
        calls.push(invocation);
        return report({ plan: { compose: { spec: canonicalSpec } } });
      },
    });
    const handle = await startUiServer({ dshHome, engines });
    try {
      const input = {
        profile: 'target-profile',
        spec: {
          ...canonicalSpec,
          include: [{ from: 'https://github.com/owner/repo', skills: ['notes'] }],
        },
      };
      const planned = await post(
        origin(handle.url),
        { operation: 'compose', phase: 'plan', input, authorizedDangerousPermissions: [] },
        handle.token,
      );
      const planDigest = (planned.body.metadata as JsonObject).planDigest as string;
      const applied = await post(
        origin(handle.url),
        {
          operation: 'compose',
          phase: 'apply',
          input,
          planDigest,
          authorizedDangerousPermissions: [],
        },
        handle.token,
      );

      expect(applied.status).toBe(200);
      expect(calls[2]).toMatchObject({
        phase: 'apply',
        input: { spec: { include: [{ from: pinned, skills: ['notes'] }] } },
      });
    } finally {
      await handle.close();
    }
  });

  it('derives structured update permissions from every valid authorization delta', async () => {
    const dshHome = await temporaryHome();
    const requiredUpdatePermissions = [
      { kind: 'new-plugin', subject: 'plugin-a', identity: 'identity-a' },
      { kind: 'allow-build', subject: 'plugin-a' },
      { kind: 'danger-full-access', subject: 'danger-full-access' },
      { kind: 'version-mismatch', subject: '1.0.0', tested: ['2.0.0'] },
    ] as const;
    const engines = inertEngines({
      runWrite: async () =>
        report({
          preflight: {
            authorizationDelta: [
              null,
              {},
              { kind: 'new-plugin' },
              { kind: 'new-plugin', plugin: 'plugin-a', identity: 'identity-a' },
              { kind: 'allow-build' },
              { kind: 'allow-build', authorization: 'plugin-a' },
              { kind: 'danger-full-access' },
              { kind: 'version-mismatch', current: 1, tested: [] },
              { kind: 'version-mismatch', current: '1.0.0', tested: ['2.0.0'] },
              { kind: 'future-permission' },
            ],
          },
        }),
    });
    const handle = await startUiServer({ dshHome, engines });
    try {
      const response = await post(
        origin(handle.url),
        {
          operation: 'update',
          phase: 'plan',
          input: { profile: 'fixture-profile' },
          authorizedDangerousPermissions: requiredUpdatePermissions,
        },
        handle.token,
      );
      expect(response.body).toMatchObject({
        exitCode: EXIT_CODES.SUCCESS,
        metadata: { requiredDangerousPermissions: requiredUpdatePermissions },
      });
    } finally {
      await handle.close();
    }
  });

  it.each(operations)(
    '%s rejects exactly the missing items and never remembers authorization',
    async (operation) => {
      const dshHome = await temporaryHome();
      const current = fixture();
      const handle = await startUiServer({ dshHome, engines: current.engines });
      const base = origin(handle.url);
      try {
        const partial = await post(
          base,
          {
            operation,
            phase: 'plan',
            input: {},
            authorizedDangerousPermissions: [required[0]],
          },
          handle.token,
        );
        expect(partial.body).toMatchObject({
          exitCode: EXIT_CODES.USER_DECLINED,
          metadata: {
            requiredDangerousPermissions: required,
            authorizedDangerousPermissions: [required[0]],
            missingDangerousPermissions: [required[1]],
            planDigest: expect.stringMatching(/^sha256-[A-Za-z0-9_-]+$/u),
          },
        });

        const authorized = await post(
          base,
          { operation, phase: 'plan', input: {}, authorizedDangerousPermissions: required },
          handle.token,
        );
        expect(authorized.body).toMatchObject({
          exitCode: EXIT_CODES.SUCCESS,
          metadata: { missingDangerousPermissions: [] },
        });

        const forgotten = await post(
          base,
          { operation, phase: 'plan', input: {}, authorizedDangerousPermissions: [] },
          handle.token,
        );
        expect(forgotten.body).toMatchObject({
          exitCode: EXIT_CODES.USER_DECLINED,
          metadata: { missingDangerousPermissions: required },
        });
        expect(current.calls.every((call) => call.phase === 'plan')).toBe(true);
      } finally {
        await handle.close();
      }
    },
  );

  it.each(operations)(
    '%s replans before apply and rejects a tampered or stale digest without calling apply',
    async (operation) => {
      const dshHome = await temporaryHome();
      const current = fixture();
      const handle = await startUiServer({ dshHome, engines: current.engines });
      const base = origin(handle.url);
      try {
        const planned = await post(
          base,
          { operation, phase: 'plan', input: {}, authorizedDangerousPermissions: required },
          handle.token,
        );
        const planDigest = (planned.body.metadata as JsonObject).planDigest as string;

        const tampered = await post(
          base,
          {
            operation,
            phase: 'apply',
            input: {},
            authorizedDangerousPermissions: required,
            planDigest: `${planDigest}-tampered`,
          },
          handle.token,
        );
        expect(tampered.body).toMatchObject({
          exitCode: EXIT_CODES.CONTRACT,
          diagnostics: [expect.objectContaining({ code: 'E_UI_PLAN_CHANGED' })],
        });
        expect(current.calls.filter((call) => call.phase === 'apply')).toHaveLength(0);

        current.setRevision(2);
        const stale = await post(
          base,
          {
            operation,
            phase: 'apply',
            input: {},
            authorizedDangerousPermissions: required,
            planDigest,
          },
          handle.token,
        );
        expect(stale.body).toMatchObject({ exitCode: EXIT_CODES.CONTRACT });
        expect(current.calls.filter((call) => call.phase === 'apply')).toHaveLength(0);

        const currentPlan = await post(
          base,
          { operation, phase: 'plan', input: {}, authorizedDangerousPermissions: required },
          handle.token,
        );
        const currentDigest = (currentPlan.body.metadata as JsonObject).planDigest as string;
        const applied = await post(
          base,
          {
            operation,
            phase: 'apply',
            input: {},
            authorizedDangerousPermissions: required,
            planDigest: currentDigest,
          },
          handle.token,
        );
        expect(applied.body).toMatchObject({ exitCode: EXIT_CODES.SUCCESS });
        expect(current.calls.filter((call) => call.phase === 'apply')).toHaveLength(1);
      } finally {
        await handle.close();
      }
    },
  );

  it('checks missing authorization before digest equality and does not enter apply', async () => {
    const dshHome = await temporaryHome();
    const current = fixture();
    const handle = await startUiServer({ dshHome, engines: current.engines });
    try {
      const response = await post(
        origin(handle.url),
        {
          operation: 'install',
          phase: 'apply',
          input: {},
          authorizedDangerousPermissions: [required[0]],
          planDigest: 'sha256-wrong',
        },
        handle.token,
      );
      expect(response.body).toMatchObject({
        exitCode: EXIT_CODES.USER_DECLINED,
        diagnostics: [expect.objectContaining({ code: 'E_UI_AUTHORIZATION_REQUIRED' })],
        metadata: { missingDangerousPermissions: [required[1]] },
      });
      expect(current.calls).toHaveLength(1);
      expect(current.calls[0]?.phase).toBe('plan');
    } finally {
      await handle.close();
    }
  });
});

describe('a refused apply does not answer with a success status', () => {
  // The body already carries the exit code, but a client that checks `response.ok` before reading
  // it would record an install that never ran — the same shape as the silent exit 0 this project
  // refuses elsewhere. The distinction is by phase, not by exit code: a plan that reports what
  // still needs authorizing is the flow working.
  const required = [{ kind: 'force', subject: 'gc' }] as const;

  async function serve() {
    const dshHome = await temporaryHome();
    const handle = await startUiServer({ dshHome, engines: inertEngines() });
    return { handle, base: origin(handle.url) };
  }

  it('answers a plan that still needs authorization with 200', async () => {
    const { handle, base } = await serve();
    try {
      const planned = await post(
        base,
        {
          operation: 'gc',
          phase: 'plan',
          input: { force: true },
          authorizedDangerousPermissions: [],
        },
        handle.token,
      );
      expect(planned.status).toBe(200);
      expect(planned.body).toMatchObject({
        exitCode: EXIT_CODES.USER_DECLINED,
        metadata: { missingDangerousPermissions: [...required] },
      });
    } finally {
      await handle.close();
    }
  });

  it('answers a refused apply with 403 and a changed plan with 409', async () => {
    const { handle, base } = await serve();
    try {
      const unauthorized = await post(
        base,
        {
          operation: 'gc',
          phase: 'apply',
          input: { force: true },
          authorizedDangerousPermissions: [],
          planDigest: 'sha256-stale',
        },
        handle.token,
      );
      expect(unauthorized.status).toBe(403);
      expect(unauthorized.body).toMatchObject({ exitCode: EXIT_CODES.USER_DECLINED });

      const stale = await post(
        base,
        {
          operation: 'gc',
          phase: 'apply',
          input: { force: true },
          authorizedDangerousPermissions: [...required],
          planDigest: 'sha256-stale',
        },
        handle.token,
      );
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({
        exitCode: EXIT_CODES.CONTRACT,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'E_UI_PLAN_CHANGED' }),
        ]),
      });
    } finally {
      await handle.close();
    }
  });
});

describe('forbidden authority fields are refused per key, not just as a branch', () => {
  // The existing malformed-request test covers `yes`, which proves the branch runs. It does not
  // pin membership of the set, and the keys are not interchangeable: `fix` is the one that turns a
  // read-classified endpoint into a writing one, because `doctor --fix` rewrites an empty patch
  // and renames skills. Dropping just that entry would leave every other case green.
  it.each(['fix', 'dshHome', 'dryRun', 'interactive'])(
    'refuses a read request smuggling %s before the engine runs',
    async (key) => {
      const dshHome = await temporaryHome();
      const runRead = vi.fn(async () => report({ ok: true }));
      const engines = inertEngines({ runRead });
      const handle = await startUiServer({ dshHome, engines });
      try {
        const denied = await post(
          origin(handle.url),
          { operation: 'doctor', input: { profile: 'demo', [key]: true } },
          handle.token,
        );
        expect(denied.status).toBe(400);
        expect(denied.body).toMatchObject({
          diagnostics: [expect.objectContaining({ code: 'E_UI_REQUEST' })],
        });
        expect(runRead).not.toHaveBeenCalled();
      } finally {
        await handle.close();
      }
    },
  );
});

describe('M3 UI compose and skill operations', () => {
  const composeInput = {
    profile: 'combined-notes',
    spec: {
      composeVersion: 0,
      name: 'combined-notes',
      version: '1.0.0',
      description: 'A composed notes profile.',
      author: 'dshpack test',
      license: 'MIT',
      include: [{ from: './source', skills: ['notes'] }],
      defaults: { permissionPreset: 'workspace-write' },
    },
  } as const;
  const editInput = {
    profile: 'combined-notes',
    skillId: 'notes',
    content: '# User notes\n',
  } as const;
  const required = [{ kind: 'force', subject: 'combined-notes' }] as const;

  it('allows the compose-only license acknowledgement through the write gateway', async () => {
    const dshHome = await temporaryHome();
    const runWrite = vi.fn(async ({ operation, phase }) => report({ operation, phase }));
    const handle = await startUiServer({ dshHome, engines: inertEngines({ runWrite }) });
    try {
      const input = { ...composeInput, allowUnknownLicense: true } as const;
      const planned = await post(
        origin(handle.url),
        {
          operation: 'compose',
          phase: 'plan',
          input,
          authorizedDangerousPermissions: [],
        },
        handle.token,
      );
      expect(planned).toMatchObject({ status: 200, body: { exitCode: EXIT_CODES.SUCCESS } });
      expect(runWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'compose',
          phase: 'plan',
          input: expect.objectContaining({ allowUnknownLicense: true, dshHome }),
        }),
      );
      const planDigest = (planned.body.metadata as JsonObject).planDigest as string;
      const applied = await post(
        origin(handle.url),
        {
          operation: 'compose',
          phase: 'apply',
          input,
          authorizedDangerousPermissions: [],
          planDigest,
        },
        handle.token,
      );
      expect(applied).toMatchObject({ status: 200, body: { exitCode: EXIT_CODES.SUCCESS } });
      expect(runWrite).toHaveBeenLastCalledWith(
        expect.objectContaining({
          operation: 'compose',
          phase: 'apply',
          input: expect.objectContaining({ allowUnknownLicense: true, dshHome }),
        }),
      );

      for (const request of [
        {
          operation: 'compose',
          phase: 'plan',
          input: { ...composeInput, allowUnknownLicense: 'true' },
          authorizedDangerousPermissions: [],
        },
        {
          operation: 'compose',
          phase: 'plan',
          input: { ...composeInput, unexpected: true },
          authorizedDangerousPermissions: [],
        },
        {
          operation: 'composePreview',
          input: { spec: composeInput.spec, allowUnknownLicense: true },
        },
      ]) {
        const denied = await post(origin(handle.url), request, handle.token);
        expect(denied).toMatchObject({
          status: 400,
          body: { diagnostics: [expect.objectContaining({ code: 'E_UI_REQUEST' })] },
        });
      }
      expect(runWrite).toHaveBeenCalledTimes(3);
    } finally {
      await handle.close();
    }
  });

  it('forwards the license acknowledgement to the default compose engine', async () => {
    const dshHome = await temporaryHome();
    const source = await enginePack({ assets: true });
    const manifestPath = join(source, 'pack.yml');
    const manifest = await readFile(manifestPath, 'utf8');
    const unlicensed = manifest.replace('license: MIT', 'license: UNLICENSED');
    expect(unlicensed).not.toBe(manifest);
    await writeFile(manifestPath, unlicensed);
    const lockPath = join(source, 'pack.lock.yml');
    const lock = await readFile(lockPath, 'utf8');
    await writeFile(
      lockPath,
      lock.replace(
        /manifestSha256: .+/u,
        `manifestSha256: sha256-${createHash('sha256').update(unlicensed).digest('base64url')}`,
      ),
    );
    const handle = await startUiServer({
      dshHome,
      runtime: createNodeInstallRuntime(dshHome),
    });
    try {
      const response = await post(
        origin(handle.url),
        {
          operation: 'compose',
          phase: 'plan',
          input: {
            ...composeInput,
            allowUnknownLicense: true,
            spec: { ...composeInput.spec, include: [{ from: source, skills: ['notes'] }] },
          },
          authorizedDangerousPermissions: [],
        },
        handle.token,
      );
      expect(response.status).toBe(200);
      expect(response.body.diagnostics).toEqual(
        expect.not.arrayContaining([
          expect.objectContaining({ code: 'E_COMPOSE_UNKNOWN_LICENSE_CONFIRM' }),
        ]),
      );
    } finally {
      await handle.close();
    }
  });

  it.each([
    ['compose', composeInput],
    ['editSkill', editInput],
  ] as const)(
    'keeps %s behind the existing missing-grant and digest gates',
    async (operation, input) => {
      const dshHome = await temporaryHome();
      const calls: UiServerWriteInvocation[] = [];
      const engines = inertEngines({
        runWrite: async (invocation) => {
          calls.push(invocation);
          return report({
            requiredDangerousPermissions: required,
            plan: { operation: invocation.operation, input: invocation.input },
          });
        },
      });
      const handle = await startUiServer({ dshHome, engines });
      try {
        const missing = await post(
          origin(handle.url),
          { operation, phase: 'plan', input, authorizedDangerousPermissions: [] },
          handle.token,
        );
        expect(missing).toMatchObject({
          status: 200,
          body: {
            exitCode: EXIT_CODES.USER_DECLINED,
            metadata: { missingDangerousPermissions: required },
          },
        });

        const planned = await post(
          origin(handle.url),
          { operation, phase: 'plan', input, authorizedDangerousPermissions: required },
          handle.token,
        );
        const planDigest = (planned.body.metadata as JsonObject).planDigest as string;
        const changed = await post(
          origin(handle.url),
          {
            operation,
            phase: 'apply',
            input,
            authorizedDangerousPermissions: required,
            planDigest: `${planDigest}-changed`,
          },
          handle.token,
        );
        expect(changed).toMatchObject({
          status: 409,
          body: { diagnostics: [expect.objectContaining({ code: 'E_UI_PLAN_CHANGED' })] },
        });
        expect(calls.filter((call) => call.phase === 'apply')).toHaveLength(0);
      } finally {
        await handle.close();
      }
    },
  );

  it('enforces closed ids, content size, and preview no-write behavior at the HTTP boundary', async () => {
    const dshHome = await temporaryHome();
    await mkdir(join(dshHome, 'skills', 'notes'), { recursive: true });
    await writeFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), '# Original notes\n');
    const source = await enginePack({ assets: true });
    const before = await byteSnapshot(dshHome);
    const handle = await startUiServer({ dshHome });
    try {
      const preview = await post(
        origin(handle.url),
        {
          operation: 'composePreview',
          input: {
            spec: {
              ...composeInput.spec,
              include: [{ from: source, skills: ['notes'] }],
            },
          },
        },
        handle.token,
      );
      expect(preview).toMatchObject({
        status: 200,
        body: {
          exitCode: EXIT_CODES.SUCCESS,
          metadata: {
            phase: 'preview',
            sourceSkills: [expect.objectContaining({ skills: ['notes'] })],
          },
        },
      });
      expect(await byteSnapshot(dshHome)).toBe(before);

      for (const skillId of ['..', '../notes', 'notes/child', 'notes\\child']) {
        const denied = await post(
          origin(handle.url),
          { operation: 'skillContent', input: { profile: 'combined-notes', skillId } },
          handle.token,
        );
        expect(denied).toMatchObject({
          status: 400,
          body: { diagnostics: [expect.objectContaining({ code: 'E_UI_REQUEST' })] },
        });
      }

      const tooLarge = await post(
        origin(handle.url),
        {
          operation: 'editSkill',
          phase: 'plan',
          input: { ...editInput, content: 'x'.repeat(256 * 1024 + 1) },
          authorizedDangerousPermissions: [],
        },
        handle.token,
      );
      expect(tooLarge).toMatchObject({
        status: 200,
        body: {
          exitCode: EXIT_CODES.CONTRACT,
          diagnostics: [expect.objectContaining({ code: 'E_UI_SKILL_CONTENT_TOO_LARGE' })],
        },
      });
      expect(await readFile(join(dshHome, 'skills', 'notes', 'SKILL.md'), 'utf8')).toBe(
        '# Original notes\n',
      );
    } finally {
      await handle.close();
    }
  });
});

describe('itemized grants answer only the prompt they name', () => {
  // This is the second of two gates: the gateway already refuses a plan whose required set is not
  // covered, so no request can reach here with an unmatched name unless the two derivations
  // disagree. Testing it directly is the point — a rule that is only correct because another layer
  // happens to agree is a rule nobody is checking, and that agreement is not enforced anywhere.
  const grant = { kind: 'allow-build', subject: 'foo' } as const;

  it('refuses a prompt whose subject merely contains the granted name', () => {
    expect(
      promptAuthorized({ kind: 'allow-build', subject: 'foo-core', defaultValue: false }, [grant]),
    ).toBe(false);
    expect(
      promptAuthorized({ kind: 'allow-build', subject: 'my-foo', defaultValue: false }, [grant]),
    ).toBe(false);
    expect(
      promptAuthorized({ kind: 'allow-build', subject: '@scope/foo', defaultValue: false }, [
        grant,
      ]),
    ).toBe(false);
  });

  it('authorizes the exact name, and never across kinds', () => {
    expect(
      promptAuthorized({ kind: 'allow-build', subject: 'foo', defaultValue: false }, [grant]),
    ).toBe(true);
    expect(
      promptAuthorized({ kind: 'new-plugin', subject: 'foo', defaultValue: false }, [grant]),
    ).toBe(false);
  });

  it('matches the two subject-less kinds on kind alone', () => {
    // Their prompt subject is a rendered sentence while the wire stores the bare version, so a
    // subject comparison here would fail closed and silently make the toggle unusable.
    expect(
      promptAuthorized(
        { kind: 'version-mismatch', subject: '0.1.0-rc.5 ∉ dsh.tested', defaultValue: false },
        [{ kind: 'version-mismatch', subject: '0.1.0-rc.5', tested: ['0.1.0-rc.6'] }],
      ),
    ).toBe(true);
    expect(
      promptAuthorized(
        { kind: 'danger-full-access', subject: 'danger-full-access', defaultValue: false },
        [{ kind: 'danger-full-access', subject: 'danger-full-access' }],
      ),
    ).toBe(true);
    expect(
      promptAuthorized({ kind: 'version-mismatch', subject: 'x', defaultValue: false }, [grant]),
    ).toBe(false);
  });
});
