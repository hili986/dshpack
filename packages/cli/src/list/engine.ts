import type { Dirent } from 'node:fs';
import { type CommandReport, diagnostic, resolveDshHomeValue } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { inspectMetadata, inspectProfile } from './contracts.js';
import { bindSecureRoot, readDirectory, type SafePathResult } from './safe-fs.js';

export type ProfileStatus = 'tracked' | 'untracked' | 'broken';

export type ListedProfile =
  | {
      profile: string;
      status: 'tracked';
      pack: { name: string; version: string };
      installedAt: string;
    }
  | { profile: string; status: 'untracked' }
  | { profile: string; status: 'broken'; reason: string };

export interface ListMetadata {
  profiles: readonly ListedProfile[];
}

export interface ListInput {
  dshHome: string;
}

function commandFailure(
  code: string,
  message: string,
  exitCode: ExitCode,
): CommandReport<ListMetadata> {
  return {
    diagnostics: [diagnostic(code, 'error', message, '设置有效的 --dsh-home 或 DSH_HOME 后重试。')],
    exitCode,
    metadata: { profiles: [] },
  };
}

function entries(result: SafePathResult<Dirent<string>[]>): Dirent<string>[] | undefined {
  if (result.ok) return result.value;
  return result.kind === 'missing' || result.kind === 'security' ? [] : undefined;
}

function sortNames(names: Iterable<string>): string[] {
  return [...names].sort();
}

export async function listProfiles(input: ListInput): Promise<CommandReport<ListMetadata>> {
  const resolution = resolveDshHomeValue(input.dshHome);
  if (!resolution.ok) {
    const item = resolution.report.diagnostics[0] as NonNullable<
      (typeof resolution.report.diagnostics)[number]
    >;
    return commandFailure(item.code, item.message, resolution.report.exitCode);
  }
  const dshHome = resolution.value;
  const home = await bindSecureRoot(dshHome);
  if (!home.ok)
    return commandFailure(
      home.kind === 'security' ? 'E_PATH_DSH_HOME' : 'E_LIST_DSH_HOME',
      home.reason,
      home.kind === 'security' ? EXIT_CODES.SECURITY : EXIT_CODES.ENVIRONMENT,
    );
  const profileResult = await readDirectory(home.value, ['profiles']);
  const profileEntries = entries(profileResult);
  if (profileEntries === undefined)
    return commandFailure(
      'E_LIST_PROFILES',
      '无法读取 DSH_HOME/profiles。',
      EXIT_CODES.ENVIRONMENT,
    );
  const markerResult = await readDirectory(home.value, ['.dshpack', 'installed']);
  const markerEntries = entries(markerResult);
  if (markerEntries === undefined)
    return commandFailure(
      'E_LIST_METADATA',
      '无法读取 dshpack installed metadata。',
      EXIT_CODES.ENVIRONMENT,
    );

  const names = new Set(profileEntries.map(({ name }) => name));
  for (const marker of markerEntries)
    if (marker.name.endsWith('.json')) names.add(marker.name.slice(0, -'.json'.length));
  if (
    names.size === 0 &&
    ((!profileResult.ok && profileResult.kind === 'security') ||
      (!markerResult.ok && markerResult.kind === 'security'))
  )
    return commandFailure(
      'E_PATH_LIST_ROOT',
      'profiles 或 installed metadata 路径不安全。',
      EXIT_CODES.SECURITY,
    );

  const profiles: ListedProfile[] = [];
  for (const profile of sortNames(names)) {
    const profileState = await inspectProfile(dshHome, profile);
    const metadataState = await inspectMetadata(dshHome, profile);
    if (profileState.status === 'missing') {
      profiles.push({
        profile,
        status: 'broken',
        reason: 'installed metadata 对应的 profile 不存在。',
      });
      continue;
    }
    if (profileState.status === 'broken') {
      profiles.push({ profile, status: 'broken', reason: profileState.reason });
      continue;
    }
    if (metadataState.status === 'missing') {
      profiles.push({ profile, status: 'untracked' });
      continue;
    }
    if (metadataState.status === 'broken') {
      profiles.push({ profile, status: 'broken', reason: metadataState.reason });
      continue;
    }
    profiles.push({
      profile,
      status: 'tracked',
      pack: {
        name: metadataState.metadata.pack.name,
        version: metadataState.metadata.pack.version,
      },
      installedAt: metadataState.metadata.installedAt,
    });
  }
  return { diagnostics: [], exitCode: EXIT_CODES.SUCCESS, metadata: { profiles } };
}
