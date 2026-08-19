import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

import type { Diagnostic } from '@dshpack/core';
import { valid } from 'semver';

import { diagnostic } from '../commands/shared.js';
import { assertPortableSnapshotEntries } from '../install/snapshot-path.js';
import {
  bindDirectory,
  bindSecureRoot,
  type DirectoryBinding,
  readBytes,
  readDirectory,
  readText,
  revalidateDirectoryEntries,
  type SafePathFailure,
  type SafePathHooks,
} from '../list/safe-fs.js';
import {
  type InstalledMetadataV1,
  isAddressableProfileName,
  isCanonicalSha256Sri,
  isCanonicalSha512Sri,
  isInstallableProfileName,
  isValidSettingsContribution,
  parseInstalledMetadata,
} from '../metadata/contracts.js';
import {
  casStoreShard,
  type GenerationDocument,
  type GenerationOperation,
  generationFilename,
  isCanonicalCasStoreShard,
} from '../metadata/state-storage.js';
import { MAX_TRANSACTION_STATE_BYTES } from '../transaction-types.js';

const COMMIT = /^[a-f0-9]{40}$/u;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPO = /^[A-Za-z0-9._-]+$/u;
const STORE_PREFIX = /^[A-Za-z0-9_-]{2}$/u;
const TXID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_GENERATION_CURRENT_BYTES = 128;
const MAX_GENERATION_LIST_COUNT = 1_024;
const MAX_GENERATION_LIST_BYTES = MAX_TRANSACTION_STATE_BYTES;
const GENERATION_LIST_CONCURRENCY = 4;

export type ManagementStateFailureKind =
  | 'missing'
  | 'security'
  | 'changed'
  | 'environment'
  | 'contract';

/** A safe, user-presentable state-read failure; it deliberately never includes state contents. */
export class ManagementStateError extends Error {
  constructor(
    readonly kind: ManagementStateFailureKind,
    readonly diagnostic: Diagnostic,
  ) {
    super(diagnostic.message);
    this.name = 'ManagementStateError';
  }
}

export interface ManagementStateReadOptions {
  /** Test seam shared with safe filesystem readers; command callers should omit it. */
  readonly safePathHooks?: SafePathHooks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validHttps(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function validGenerationSource(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'directory' || value.kind === 'archive')
    return (
      exactKeys(value, ['kind', 'path']) && typeof value.path === 'string' && isAbsolute(value.path)
    );
  if (value.kind === 'file')
    return (
      exactKeys(value, ['kind', 'path', 'integrity']) &&
      typeof value.path === 'string' &&
      isAbsolute(value.path) &&
      typeof value.integrity === 'string' &&
      isCanonicalSha512Sri(value.integrity)
    );
  if (value.kind === 'https')
    return (
      exactKeys(value, ['kind', 'url', 'integrity']) &&
      validHttps(value.url) &&
      typeof value.integrity === 'string' &&
      isCanonicalSha512Sri(value.integrity)
    );
  if (
    value.kind !== 'github' ||
    !exactKeys(value, ['kind', 'owner', 'repo', 'commit', 'url']) ||
    typeof value.owner !== 'string' ||
    !GITHUB_OWNER.test(value.owner) ||
    typeof value.repo !== 'string' ||
    !GITHUB_REPO.test(value.repo) ||
    value.repo === '.' ||
    value.repo === '..' ||
    typeof value.commit !== 'string' ||
    !COMMIT.test(value.commit) ||
    typeof value.url !== 'string'
  )
    return false;
  return (
    value.url === `https://codeload.github.com/${value.owner}/${value.repo}/tar.gz/${value.commit}`
  );
}

function validGenerationPack(value: unknown): value is GenerationDocument['pack'] {
  return (
    isRecord(value) &&
    exactKeys(value, ['name', 'version', 'manifestDigest']) &&
    typeof value.name === 'string' &&
    isInstallableProfileName(value.name) &&
    typeof value.version === 'string' &&
    valid(value.version) === value.version &&
    typeof value.manifestDigest === 'string' &&
    isCanonicalSha256Sri(value.manifestDigest)
  );
}

function failureKind(failure: SafePathFailure): ManagementStateFailureKind {
  if (failure.kind === 'missing' || failure.kind === 'security' || failure.kind === 'changed')
    return failure.kind;
  return 'environment';
}

function stateFailure(
  kind: ManagementStateFailureKind,
  code: string,
  message: string,
  hint: string,
  path?: string,
): ManagementStateError {
  return new ManagementStateError(kind, diagnostic(code, 'error', message, hint, path));
}

function readFailure(
  failure: SafePathFailure,
  code: string,
  label: string,
  path: string,
): ManagementStateError {
  return stateFailure(
    failureKind(failure),
    code,
    `${label} cannot be read safely.`,
    'Repair the managed state and retry; no files were changed.',
    path,
  );
}

async function secureHome(dshHome: string, hooks: SafePathHooks): Promise<DirectoryBinding> {
  const root = await bindSecureRoot(dshHome, hooks);
  if (!root.ok) throw readFailure(root, 'E_MANAGEMENT_STATE_HOME', 'managed state home', dshHome);
  return root.value;
}

async function secureDirectory(
  root: DirectoryBinding,
  segments: readonly string[],
  hooks: SafePathHooks,
  code: string,
  label: string,
  dshHome: string,
): Promise<DirectoryBinding> {
  const directory = await bindDirectory(root, segments, hooks);
  if (!directory.ok) throw readFailure(directory, code, label, join(dshHome, ...segments));
  return directory.value;
}

function invalidProfile(): ManagementStateError {
  return stateFailure(
    'contract',
    'E_MANAGEMENT_PROFILE',
    'managed state profile is not a safe path segment.',
    'Use the installed profile name shown by dshpack list.',
  );
}

function validSequence(sequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= Number.MAX_SAFE_INTEGER;
}

function generationFailure(message: string): ManagementStateError {
  return stateFailure(
    'contract',
    'E_MANAGEMENT_GENERATION',
    message,
    'Repair or regenerate the generation before retrying.',
  );
}

function parseGeneration(
  value: unknown,
  profile: string,
  expectedSequence: number,
): GenerationDocument {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'seq',
      'txid',
      'createdAt',
      'operation',
      'pack',
      'source',
      'entries',
      'settingsContribution',
      'metadata',
      'restorable',
    ])
  )
    throw generationFailure('generation document does not satisfy the v1 contract.');
  if (
    value.seq !== expectedSequence ||
    typeof value.txid !== 'string' ||
    !TXID.test(value.txid) ||
    !validTimestamp(value.createdAt) ||
    !validGenerationPack(value.pack) ||
    !validGenerationSource(value.source) ||
    !isValidSettingsContribution(value.settingsContribution) ||
    typeof value.restorable !== 'boolean' ||
    !Array.isArray(value.entries)
  )
    throw generationFailure('generation document does not satisfy the v1 contract.');
  if (
    value.operation !== 'install' &&
    value.operation !== 'update' &&
    value.operation !== 'uninstall' &&
    value.operation !== 'restore'
  )
    throw generationFailure('generation document has an unsupported operation.');

  let metadata: InstalledMetadataV1 | null;
  if (value.metadata === null) {
    if (value.operation !== 'uninstall' && value.operation !== 'restore')
      throw generationFailure('generation metadata does not describe its effective marker state.');
    metadata = null;
  } else {
    const parsed = parseInstalledMetadata(value.metadata, profile);
    if (
      !parsed.ok ||
      parsed.metadata.metadataVersion !== 1 ||
      value.operation === 'uninstall' ||
      parsed.metadata.generation !== expectedSequence ||
      JSON.stringify(parsed.metadata.settingsContribution) !==
        JSON.stringify(value.settingsContribution)
    )
      throw generationFailure('generation metadata does not describe its effective marker state.');
    metadata = parsed.metadata;
  }

  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['target', 'sha256']) ||
      typeof entry.target !== 'string' ||
      typeof entry.sha256 !== 'string'
    )
      throw generationFailure('generation document contains an invalid immutable entry.');
    if (!isCanonicalSha256Sri(entry.sha256))
      throw generationFailure('generation document contains an invalid immutable digest.');
    return { target: entry.target, sha256: entry.sha256 };
  });
  try {
    assertPortableSnapshotEntries(entries.map((entry) => ({ path: entry.target, kind: 'file' })));
  } catch {
    throw generationFailure('generation document contains unsafe immutable paths.');
  }
  return {
    seq: expectedSequence,
    txid: value.txid,
    createdAt: value.createdAt,
    operation: value.operation as GenerationOperation,
    pack: {
      name: value.pack.name,
      version: value.pack.version,
      manifestDigest: value.pack.manifestDigest,
    },
    source: value.source,
    entries,
    settingsContribution: value.settingsContribution,
    metadata,
    restorable: value.restorable,
  };
}

/** Securely read the current v1 installed marker for a named profile. */
export async function readTrackedMetadata(
  dshHome: string,
  profile: string,
  options: ManagementStateReadOptions = {},
): Promise<InstalledMetadataV1> {
  if (!isAddressableProfileName(profile)) throw invalidProfile();
  const hooks = options.safePathHooks ?? {};
  const root = await secureHome(dshHome, hooks);
  const installed = await secureDirectory(
    root,
    ['.dshpack', 'installed'],
    hooks,
    'E_MANAGEMENT_METADATA',
    'installed metadata directory',
    dshHome,
  );
  const markerPath = join(dshHome, '.dshpack', 'installed', `${profile}.json`);
  const marker = await readText(installed, [`${profile}.json`], hooks, MAX_TRANSACTION_STATE_BYTES);
  if (!marker.ok)
    throw readFailure(marker, 'E_MANAGEMENT_METADATA', 'installed metadata', markerPath);
  let value: unknown;
  try {
    value = JSON.parse(marker.value.text);
  } catch {
    throw stateFailure(
      'contract',
      'E_MANAGEMENT_METADATA',
      'installed metadata is not valid JSON.',
      'Repair or reinstall the managed profile before retrying.',
      markerPath,
    );
  }
  const parsed = parseInstalledMetadata(value, profile);
  if (!parsed.ok || parsed.metadata.metadataVersion !== 1)
    throw stateFailure(
      'contract',
      'E_MANAGEMENT_METADATA',
      'installed metadata is not a complete v1 record for this profile.',
      'Run dshpack migrate for legacy state, or repair the marker before retrying.',
      markerPath,
    );
  return parsed.metadata;
}

/** Securely read and strictly parse one immutable generation document with its bounded input size. */
async function readGenerationSized(
  dshHome: string,
  profile: string,
  sequence: number,
  options: ManagementStateReadOptions = {},
): Promise<{ readonly generation: GenerationDocument; readonly byteLength: number }> {
  if (!isAddressableProfileName(profile)) throw invalidProfile();
  if (!validSequence(sequence))
    throw stateFailure(
      'contract',
      'E_MANAGEMENT_GENERATION',
      'generation sequence is outside the safe positive range.',
      'Select a positive generation sequence and retry.',
    );
  const hooks = options.safePathHooks ?? {};
  const root = await secureHome(dshHome, hooks);
  const generations = await secureDirectory(
    root,
    ['.dshpack', 'generations', profile],
    hooks,
    'E_MANAGEMENT_GENERATION',
    'generation directory',
    dshHome,
  );
  const filename = generationFilename(sequence);
  const path = join(dshHome, '.dshpack', 'generations', profile, filename);
  const document = await readText(generations, [filename], hooks, MAX_TRANSACTION_STATE_BYTES);
  if (!document.ok) throw readFailure(document, 'E_MANAGEMENT_GENERATION', 'generation', path);
  let value: unknown;
  try {
    value = JSON.parse(document.value.text);
  } catch {
    throw stateFailure(
      'contract',
      'E_MANAGEMENT_GENERATION',
      'generation document is not valid JSON.',
      'Repair or regenerate the generation before retrying.',
      path,
    );
  }
  try {
    return {
      generation: parseGeneration(value, profile, sequence),
      byteLength: Buffer.byteLength(document.value.text, 'utf8'),
    };
  } catch (error) {
    if (error instanceof ManagementStateError && error.diagnostic.path === undefined)
      throw stateFailure(
        error.kind,
        error.diagnostic.code,
        error.diagnostic.message,
        error.diagnostic.hint ?? 'Repair or regenerate the generation before retrying.',
        path,
      );
    throw error;
  }
}

/** Securely read and strictly parse one immutable generation document. */
export async function readGeneration(
  dshHome: string,
  profile: string,
  sequence: number,
  options: ManagementStateReadOptions = {},
): Promise<GenerationDocument> {
  return (await readGenerationSized(dshHome, profile, sequence, options)).generation;
}

/** Read the canonical current pointer without trusting an unbounded or linked state file. */
export async function readGenerationCurrent(
  dshHome: string,
  profile: string,
  options: ManagementStateReadOptions = {},
): Promise<number> {
  if (!isAddressableProfileName(profile)) throw invalidProfile();
  const hooks = options.safePathHooks ?? {};
  const root = await secureHome(dshHome, hooks);
  const generations = await secureDirectory(
    root,
    ['.dshpack', 'generations', profile],
    hooks,
    'E_MANAGEMENT_GENERATION',
    'generation directory',
    dshHome,
  );
  const path = join(dshHome, '.dshpack', 'generations', profile, 'current');
  const current = await readText(generations, ['current'], hooks, MAX_GENERATION_CURRENT_BYTES);
  if (!current.ok)
    throw readFailure(current, 'E_MANAGEMENT_GENERATION', 'generation current', path);
  if (!/^[1-9]\d*\n$/u.test(current.value.text))
    throw generationFailure('generation current pointer is not a canonical positive sequence.');
  const sequence = Number(current.value.text.slice(0, -1));
  if (!validSequence(sequence))
    throw generationFailure('generation current pointer is outside the safe positive range.');
  return sequence;
}

/** List every immutable generation after securely validating directory entries and their documents. */
export async function listGenerations(
  dshHome: string,
  profile: string,
  options: ManagementStateReadOptions = {},
): Promise<readonly GenerationDocument[]> {
  if (!isAddressableProfileName(profile)) throw invalidProfile();
  const hooks = options.safePathHooks ?? {};
  const root = await secureHome(dshHome, hooks);
  const generations = await secureDirectory(
    root,
    ['.dshpack', 'generations', profile],
    hooks,
    'E_MANAGEMENT_GENERATION',
    'generation directory',
    dshHome,
  );
  const entries = await readDirectory(generations, [], hooks);
  const path = join(dshHome, '.dshpack', 'generations', profile);
  if (!entries.ok)
    throw readFailure(entries, 'E_MANAGEMENT_GENERATION', 'generation directory', path);
  const sequences: number[] = [];
  for (const entry of entries.value) {
    if (entry.name === 'current') continue;
    if (!entry.isFile() || entry.isSymbolicLink() || !/^\d+\.json$/u.test(entry.name))
      throw generationFailure('generation directory contains a non-canonical immutable entry.');
    const sequence = Number(entry.name.slice(0, -'.json'.length));
    if (!validSequence(sequence) || generationFilename(sequence) !== entry.name)
      throw generationFailure('generation directory contains an invalid sequence filename.');
    sequences.push(sequence);
  }
  if (sequences.length > MAX_GENERATION_LIST_COUNT)
    throw generationFailure('generation directory exceeds the bounded retained-generation count.');
  const stable = await revalidateDirectoryEntries(generations, entries.value, hooks);
  if (!stable.ok)
    throw readFailure(stable, 'E_MANAGEMENT_GENERATION', 'generation directory', path);
  const ordered = sequences.sort((left, right) => left - right);
  const result = new Array<GenerationDocument>(ordered.length);
  let next = 0;
  let aggregateBytes = 0;
  const worker = async (): Promise<void> => {
    while (next < ordered.length) {
      const index = next;
      next += 1;
      const sequence = ordered[index];
      if (sequence === undefined) return;
      const document = await readGenerationSized(dshHome, profile, sequence, options);
      aggregateBytes += document.byteLength;
      if (aggregateBytes > MAX_GENERATION_LIST_BYTES)
        throw generationFailure('generation documents exceed the bounded aggregate read limit.');
      result[index] = document.generation;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(GENERATION_LIST_CONCURRENCY, ordered.length) }, worker),
  );
  return result;
}

/** Securely read an immutable CAS block and prove its bytes match the requested digest. */
export async function readCasBlock(
  dshHome: string,
  digest: string,
  options: ManagementStateReadOptions = {},
): Promise<Buffer> {
  if (!isCanonicalSha256Sri(digest))
    throw stateFailure(
      'contract',
      'E_MANAGEMENT_CAS',
      'CAS digest is not a valid SHA-256 SRI value.',
      'Repair the generation metadata before retrying.',
    );
  const hooks = options.safePathHooks ?? {};
  const root = await secureHome(dshHome, hooks);
  const shard = casStoreShard(digest);
  const storeRoot = await secureDirectory(
    root,
    ['.dshpack', 'store'],
    hooks,
    'E_MANAGEMENT_CAS',
    'CAS store directory',
    dshHome,
  );
  const prefixes = await readDirectory(storeRoot, [], hooks);
  const storeRootPath = join(dshHome, '.dshpack', 'store');
  if (!prefixes.ok)
    throw readFailure(prefixes, 'E_MANAGEMENT_CAS', 'CAS store directory', storeRootPath);
  for (const entry of prefixes.value) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !STORE_PREFIX.test(entry.name) ||
      entry.name !== entry.name.toLowerCase()
    )
      throw stateFailure(
        'security',
        'E_MANAGEMENT_CAS',
        'CAS store contains an unsafe shard entry.',
        'Repair the CAS store before retrying.',
        storeRootPath,
      );
  }
  if (!prefixes.value.some((entry) => entry.name === shard))
    throw stateFailure(
      'missing',
      'E_MANAGEMENT_CAS',
      'requested CAS shard is missing.',
      'Repair or regenerate the generation before retrying.',
      join(storeRootPath, shard),
    );
  const store = await secureDirectory(
    root,
    ['.dshpack', 'store', shard],
    hooks,
    'E_MANAGEMENT_CAS',
    'CAS shard directory',
    dshHome,
  );
  const entries = await readDirectory(store, [], hooks);
  const path = join(dshHome, '.dshpack', 'store', shard, digest);
  if (!entries.ok) throw readFailure(entries, 'E_MANAGEMENT_CAS', 'CAS shard directory', path);
  for (const entry of entries.value) {
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !isCanonicalSha256Sri(entry.name) ||
      !isCanonicalCasStoreShard(shard, entry.name)
    )
      throw stateFailure(
        'security',
        'E_MANAGEMENT_CAS',
        'CAS shard contains an unsafe block entry.',
        'Repair the CAS store before retrying.',
        join(dshHome, '.dshpack', 'store', shard),
      );
  }
  if (!entries.value.some((entry) => entry.name === digest))
    throw stateFailure(
      'missing',
      'E_MANAGEMENT_CAS',
      'requested immutable CAS block is missing.',
      'Repair or regenerate the generation before retrying.',
      path,
    );
  const block = await readBytes(store, [digest], hooks, MAX_TRANSACTION_STATE_BYTES);
  if (!block.ok) throw readFailure(block, 'E_MANAGEMENT_CAS', 'CAS block', path);
  const stableStore = await revalidateDirectoryEntries(storeRoot, prefixes.value, hooks);
  if (!stableStore.ok)
    throw readFailure(stableStore, 'E_MANAGEMENT_CAS', 'CAS store directory', storeRootPath);
  const stableShard = await revalidateDirectoryEntries(store, entries.value, hooks);
  if (!stableShard.ok)
    throw readFailure(stableShard, 'E_MANAGEMENT_CAS', 'CAS shard directory', path);
  const actual = `sha256-${createHash('sha256').update(block.value.bytes).digest('base64url')}`;
  if (actual !== digest)
    throw stateFailure(
      'contract',
      'E_MANAGEMENT_CAS',
      'CAS block bytes do not match the requested digest.',
      'Repair or regenerate the generation before retrying.',
      path,
    );
  return block.value.bytes;
}
