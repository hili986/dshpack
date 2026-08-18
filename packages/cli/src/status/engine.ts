import { type CommandReport, diagnostic } from '../commands/shared.js';
import { type DiffRuntime, diffProfile } from '../diff/engine.js';
import { EXIT_CODES } from '../exit-codes.js';
import { type ListedProfile, listProfiles } from '../list/engine.js';

export interface StatusInput {
  readonly dshHome: string;
  readonly checkUpdates?: boolean;
}

export type StatusProfile =
  | {
      readonly profile: string;
      readonly status: 'tracked';
      readonly pack: { readonly name: string; readonly version: string };
      readonly generation?: number;
      /** `'unavailable'` when the read-only plan failed: an unknown count is never reported as 0. */
      readonly drift: number | 'unavailable';
      readonly sharedAssets: number | 'unavailable';
      readonly update: 'available' | 'none' | 'not-checked' | 'unavailable';
    }
  | {
      readonly profile: string;
      readonly status: 'untracked' | 'reserved' | 'broken';
      readonly reason?: string;
    };

export interface StatusMetadata {
  readonly profiles: readonly StatusProfile[];
  readonly checkUpdates: boolean;
}

export type StatusReport = CommandReport<StatusMetadata>;

function nonTracked(
  profile: Exclude<ListedProfile, Extract<ListedProfile, { status: 'tracked' }>>,
): StatusProfile {
  if (profile.status === 'untracked') return { profile: profile.profile, status: 'untracked' };
  if (profile.status === 'reserved')
    return { profile: profile.profile, status: 'reserved', reason: profile.reason };
  return { profile: profile.profile, status: 'broken', reason: profile.reason };
}

export async function statusProfiles(
  input: StatusInput,
  runtime: DiffRuntime,
): Promise<StatusReport> {
  const listed = await listProfiles({ dshHome: input.dshHome });
  if (listed.exitCode !== EXIT_CODES.SUCCESS)
    return {
      diagnostics: listed.diagnostics,
      exitCode: listed.exitCode,
      metadata: { profiles: [], checkUpdates: input.checkUpdates === true },
    };
  const tracked = listed.metadata.profiles.filter(
    (profile): profile is Extract<ListedProfile, { status: 'tracked' }> =>
      profile.status === 'tracked',
  );
  const reports = await Promise.all(
    tracked.map((profile) =>
      diffProfile(
        {
          dshHome: input.dshHome,
          profile: profile.profile,
          ...(input.checkUpdates === true ? { checkUpdates: true } : {}),
        },
        runtime,
      ),
    ),
  );
  const digestCounts = new Map<string, number>();
  for (const report of reports)
    for (const asset of report.metadata.assetDigests)
      digestCounts.set(asset.digest, (digestCounts.get(asset.digest) ?? 0) + 1);
  const profiles: StatusProfile[] = [];
  let failed = false;
  let firstFailure: StatusReport['diagnostics'] = [];
  let failureCode: StatusReport['exitCode'] = EXIT_CODES.SUCCESS;
  let reportIndex = 0;
  for (const profile of listed.metadata.profiles) {
    if (profile.status !== 'tracked') {
      profiles.push(nonTracked(profile));
      continue;
    }
    const report = reports[reportIndex] as (typeof reports)[number];
    reportIndex += 1;
    if (report.exitCode !== EXIT_CODES.SUCCESS) {
      failed = true;
      if (firstFailure.length === 0) {
        firstFailure = report.diagnostics;
        failureCode = report.exitCode;
      }
      // Without `--check-updates` the `update` field reads `'not-checked'` for healthy and
      // unreadable profiles alike, so reporting 0 here would make an unreadable profile
      // byte-identical to a clean one for anyone consuming `--json`.
      profiles.push({
        profile: profile.profile,
        status: 'tracked',
        pack: profile.pack,
        drift: 'unavailable',
        sharedAssets: 'unavailable',
        update: input.checkUpdates === true ? 'unavailable' : 'not-checked',
      });
      continue;
    }
    const sharedAssets = report.metadata.assetDigests.filter(
      ({ digest }) => (digestCounts.get(digest) ?? 0) > 1,
    ).length;
    profiles.push({
      profile: profile.profile,
      status: 'tracked',
      pack: profile.pack,
      ...(report.metadata.generation === undefined
        ? {}
        : { generation: report.metadata.generation }),
      drift: report.metadata.localDrift.length,
      sharedAssets,
      update:
        input.checkUpdates === true
          ? report.metadata.upstreamDelta.length > 0
            ? 'available'
            : 'none'
          : 'not-checked',
    });
  }
  return {
    diagnostics: failed
      ? [
          ...firstFailure,
          diagnostic(
            'W_STATUS_PROFILE',
            'warning',
            '部分 tracked profile 无法完成只读状态计算。',
            '检查对应 profile 的管理元数据后重试。',
          ),
        ]
      : [],
    exitCode: failed ? failureCode : EXIT_CODES.SUCCESS,
    metadata: { profiles, checkUpdates: input.checkUpdates === true },
  };
}
