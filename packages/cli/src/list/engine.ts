import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { type CommandReport, diagnostic } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import { inspectMetadata, inspectProfile } from './contracts.js';

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

function environmentFailure(code: string, message: string): CommandReport<ListMetadata> {
  return {
    diagnostics: [diagnostic(code, 'error', message, '设置有效的 --dsh-home 或 DSH_HOME 后重试。')],
    exitCode: EXIT_CODES.ENVIRONMENT,
    metadata: { profiles: [] },
  };
}

async function entries(path: string): Promise<Dirent<string>[] | undefined> {
  try {
    return await readdir(path, { encoding: 'utf8', withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return undefined;
  }
}

function sortNames(names: Iterable<string>): string[] {
  return [...names].sort();
}

export async function listProfiles(input: ListInput): Promise<CommandReport<ListMetadata>> {
  if (input.dshHome.trim() === '')
    return environmentFailure('E_DSH_HOME_REQUIRED', 'DSH_HOME 为空，已拒绝从当前目录推断。');
  const dshHome = resolve(input.dshHome);
  const profileEntries = await entries(join(dshHome, 'profiles'));
  if (profileEntries === undefined)
    return environmentFailure('E_LIST_PROFILES', '无法读取 DSH_HOME/profiles。');
  const markerEntries = await entries(join(dshHome, '.dshpack', 'installed'));
  if (markerEntries === undefined)
    return environmentFailure('E_LIST_METADATA', '无法读取 dshpack installed metadata。');

  const names = new Set(profileEntries.map(({ name }) => name));
  for (const marker of markerEntries)
    if (marker.name.endsWith('.json')) names.add(marker.name.slice(0, -'.json'.length));

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
