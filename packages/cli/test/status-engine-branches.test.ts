import { afterEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODES } from '../src/exit-codes.js';

const { diffProfileMock, listProfilesMock } = vi.hoisted(() => ({
  diffProfileMock: vi.fn(),
  listProfilesMock: vi.fn(),
}));

vi.mock('../src/diff/engine.js', () => ({ diffProfile: diffProfileMock }));
vi.mock('../src/list/engine.js', () => ({ listProfiles: listProfilesMock }));

import { statusProfiles } from '../src/status/engine.js';

const tracked = (profile: string) => ({
  profile,
  status: 'tracked' as const,
  pack: { name: `${profile}-pack`, version: '1.0.0' },
  installedAt: '2026-08-18T00:00:00.000Z',
});

const report = (
  profile: string,
  input: {
    readonly exitCode?: number;
    readonly diagnostics?: readonly { readonly code: string; readonly message: string }[];
    readonly generation?: number;
    readonly upstreamDelta?: readonly object[];
  } = {},
) => ({
  diagnostics: input.diagnostics ?? [],
  exitCode: input.exitCode ?? EXIT_CODES.SUCCESS,
  metadata: {
    profile,
    pack: { name: `${profile}-pack`, version: '1.0.0' },
    localDrift: [],
    upstreamDelta: input.upstreamDelta ?? [],
    effectiveMismatch: [],
    assetDigests: [],
    ...(input.generation === undefined ? {} : { generation: input.generation }),
  },
});

afterEach(() => vi.resetAllMocks());

describe('status profiles branch handling', () => {
  it('reports an available update even when an older valid diff report has no generation', async () => {
    listProfilesMock.mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { profiles: [tracked('alpha')] },
    });
    diffProfileMock.mockResolvedValue(
      report('alpha', { upstreamDelta: [{ target: 'skills/notes' }] }),
    );

    const result = await statusProfiles({ dshHome: '/isolated', checkUpdates: true }, {} as never);

    expect(result).toMatchObject({
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        checkUpdates: true,
        profiles: [
          {
            profile: 'alpha',
            status: 'tracked',
            update: 'available',
          },
        ],
      },
    });
    expect(result.metadata.profiles[0]).not.toHaveProperty('generation');
  });

  it('never renders an unreadable profile identically to a clean one when offline', async () => {
    listProfilesMock.mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { profiles: [tracked('alpha'), tracked('beta')] },
    });
    diffProfileMock.mockImplementation(async ({ profile }: { readonly profile: string }) =>
      profile === 'alpha'
        ? report(profile, {
            exitCode: EXIT_CODES.CONTRACT,
            diagnostics: [{ code: 'E_ALPHA', message: 'unreadable' }],
          })
        : report(profile),
    );

    const result = await statusProfiles({ dshHome: '/isolated' }, {} as never);

    const [alpha, beta] = result.metadata.profiles;
    if (alpha?.status !== 'tracked' || beta?.status !== 'tracked')
      throw new Error('both fixtures must grade as tracked profiles');
    // Offline leaves `update` at 'not-checked' for both, so the drift/sharedAssets pair
    // carries the entire signal. Compare the state triple alone: profile and pack names
    // always differ, so comparing whole records would pass no matter what is reported.
    const stateOf = (entry: typeof alpha) => ({
      drift: entry.drift,
      sharedAssets: entry.sharedAssets,
      update: entry.update,
    });
    expect(stateOf(alpha)).toEqual({
      drift: 'unavailable',
      sharedAssets: 'unavailable',
      update: 'not-checked',
    });
    expect(stateOf(beta)).toEqual({ drift: 0, sharedAssets: 0, update: 'not-checked' });
    expect(stateOf(alpha)).not.toEqual(stateOf(beta));
  });

  it('keeps the first tracked read failure while still presenting later failures', async () => {
    listProfilesMock.mockResolvedValue({
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: { profiles: [tracked('alpha'), tracked('beta')] },
    });
    diffProfileMock.mockImplementation(async ({ profile }: { readonly profile: string }) =>
      profile === 'alpha'
        ? report(profile, {
            exitCode: EXIT_CODES.CONTRACT,
            diagnostics: [{ code: 'E_ALPHA', message: 'first failure' }],
          })
        : report(profile, {
            exitCode: EXIT_CODES.ENVIRONMENT,
            diagnostics: [{ code: 'E_BETA', message: 'later failure' }],
          }),
    );

    const result = await statusProfiles({ dshHome: '/isolated', checkUpdates: true }, {} as never);

    expect(result).toMatchObject({
      exitCode: EXIT_CODES.CONTRACT,
      metadata: {
        profiles: [
          expect.objectContaining({ profile: 'alpha', update: 'unavailable' }),
          expect.objectContaining({ profile: 'beta', update: 'unavailable' }),
        ],
      },
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_ALPHA' })]),
    );
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'E_BETA' })]),
    );
  });
});
