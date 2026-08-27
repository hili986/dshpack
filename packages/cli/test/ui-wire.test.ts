import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type {
  UiComposeSpec,
  UiDangerousPermission,
  UiRequest,
  UiResponse,
  UiWriteOperation,
  UiWriteRequest,
} from '../src/ui/wire.js';

const permission = {
  kind: 'allow-build',
  subject: '@scope/plugin@1.2.3',
} as const satisfies UiDangerousPermission;

const writeInputs = {
  install: { source: './pack' },
  uninstall: { profile: 'example' },
  update: { profile: 'example' },
  restore: { profile: 'example' },
  gc: {},
  compose: {
    profile: 'combined-notes',
    spec: {
      composeVersion: 0,
      name: 'combined-notes',
      version: '1.0.0',
      description: 'Combined notes skills.',
      author: 'dshpack test',
      license: 'MIT',
      include: [{ from: './source', skills: ['notes'] }],
      defaults: { permissionPreset: 'workspace-write' },
    },
  },
  editSkill: { profile: 'combined-notes', skillId: 'notes', content: '# Notes\n' },
} as const;

const composeSpec = writeInputs.compose.spec satisfies UiComposeSpec;

describe('UI wire contract', () => {
  it('represents every write as an itemized plan or digest-bound apply request', () => {
    const requests: UiWriteRequest[] = [];
    for (const operation of Object.keys(writeInputs) as UiWriteOperation[]) {
      requests.push({
        operation,
        phase: 'plan',
        input: writeInputs[operation],
        authorizedDangerousPermissions: [permission],
      } as UiWriteRequest);
      requests.push({
        operation,
        phase: 'apply',
        input: writeInputs[operation],
        authorizedDangerousPermissions: [permission],
        planDigest: 'sha256-cGxhbg',
      } as UiWriteRequest);
    }

    const roundTripped = JSON.parse(JSON.stringify(requests)) as Record<string, unknown>[];
    expect(roundTripped).toHaveLength(14);
    for (const request of roundTripped) {
      expect(request.authorizedDangerousPermissions).toEqual([permission]);
      if (request.phase === 'apply') expect(request.planDigest).toBe('sha256-cGxhbg');
      else expect(request).not.toHaveProperty('planDigest');
    }
  });

  it('keeps compose preview and skill content as path-free read contracts', () => {
    const requests: UiRequest[] = [
      { operation: 'composePreview', input: { spec: composeSpec } },
      { operation: 'skillContent', input: { profile: 'combined-notes', skillId: 'notes' } },
    ];

    expect(JSON.parse(JSON.stringify(requests))).toEqual(requests);
  });

  it('is compatible with the existing report envelope and explicit authorization metadata', () => {
    const response = {
      diagnostics: [],
      exitCode: 21,
      metadata: {
        status: 'planned',
        requiredDangerousPermissions: [permission],
        authorizedDangerousPermissions: [],
        missingDangerousPermissions: [permission],
        planDigest: 'sha256-cGxhbg',
        plan: { writes: [] },
      },
    } as const satisfies UiResponse;

    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('contains no Node imports or blanket authorization vocabulary', async () => {
    const source = await readFile(new URL('../src/ui/wire.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"]node:/u);
    expect(source).not.toMatch(/\byes\b|all-consent/iu);
  });
});

function acceptRequest(_request: UiRequest): void {}

// @ts-expect-error authorization is always an itemized array
acceptRequest({ operation: 'gc', phase: 'plan', input: {}, authorizedDangerousPermissions: true });
acceptRequest({
  operation: 'gc',
  phase: 'plan',
  input: {},
  authorizedDangerousPermissions: [],
  // @ts-expect-error blanket consent is not part of the request contract
  yes: true,
});
acceptRequest({
  operation: 'skillContent',
  // @ts-expect-error clients submit an id, never a filesystem path
  input: { profile: 'combined-notes', path: 'skills/notes/SKILL.md' },
});
// @ts-expect-error apply must bind the reviewed plan digest
acceptRequest({ operation: 'gc', phase: 'apply', input: {}, authorizedDangerousPermissions: [] });
acceptRequest({
  operation: 'gc',
  phase: 'plan',
  input: {},
  authorizedDangerousPermissions: [],
  // @ts-expect-error a plan request cannot claim an apply digest
  planDigest: 'sha256-cGxhbg',
});
// @ts-expect-error write requests always carry an authorization array, even when empty
acceptRequest({ operation: 'gc', phase: 'plan', input: {} });
// @ts-expect-error the service owns dshHome and never accepts it from a browser
acceptRequest({ operation: 'list', input: { dshHome: 'C:/untrusted' } });
// @ts-expect-error legacy consent cannot be smuggled inside an empty read input
acceptRequest({ operation: 'list', input: { yes: true } });
