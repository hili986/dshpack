import type { Dirent } from 'node:fs';
import { type CommandReport, diagnostic, resolveDshHomeValue } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import {
  inspectMetadata,
  inspectProfile,
  isReservedProfileName,
  MODULE_FALLBACK,
} from './contracts.js';
import {
  bindSecureRoot,
  type DirectoryBinding,
  readDirectory,
  readText,
  type SafePathResult,
} from './safe-fs.js';

export type ProfileStatus = 'tracked' | 'untracked' | 'reserved' | 'broken';

export type ListedProfile =
  | {
      profile: string;
      status: 'tracked';
      pack: { name: string; version: string };
      installedAt: string;
    }
  | { profile: string; status: 'untracked' }
  | { profile: string; status: 'reserved'; reason: string }
  | { profile: string; status: 'broken'; reason: string };

export interface ListMetadata {
  profiles: readonly ListedProfile[];
}

export interface ListInput {
  dshHome: string;
}

export type ListReport = CommandReport<ListMetadata>;

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

/**
 * dsh decides a directory is a profile by exactly one test — it holds a `package.json`
 * (`loadProfile` in its `app-boot/src/profile.ts`). Anything else under `profiles/` was
 * put there by some other tool and is none of our business to grade.
 *
 * `refused` is deliberately not folded into `absent`: a junction or a swapped path is a
 * finding, and dropping it for looking manifest-less would hide exactly what matters.
 */
async function profileManifest(
  home: DirectoryBinding,
  profile: string,
): Promise<'present' | 'absent' | 'refused'> {
  const result = await readText(home, ['profiles', profile, 'package.json']);
  if (result.ok) return 'present';
  return result.kind === 'missing' ? 'absent' : 'refused';
}

export async function listProfiles(input: ListInput): Promise<ListReport> {
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

  const names = new Set<string>();
  for (const entry of profileEntries) {
    // A plain file next to the profiles is somebody's scratch note, and the launcher's
    // module fallback is not a profile either — dsh refuses that name outright. Anything
    // that is neither file nor directory stays in, so inspection gets to report it.
    if (entry.isFile() || entry.name === MODULE_FALLBACK) continue;
    names.add(entry.name);
  }
  const claimed = new Set<string>();
  for (const marker of markerEntries)
    if (marker.name.endsWith('.json')) {
      const name = marker.name.slice(0, -'.json'.length);
      claimed.add(name);
      names.add(name);
    }
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
    // Silence is only safe for directories we never claimed; if dshpack recorded an
    // install here, a directory that is no longer a profile is exactly what must be said.
    if (!claimed.has(profile) && (await profileManifest(home.value, profile)) === 'absent')
      continue;
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
      profiles.push(
        isReservedProfileName(profile)
          ? { profile, status: 'reserved', reason: 'dsh 保留 profile，dshpack 不接管。' }
          : { profile, status: 'untracked' },
      );
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
