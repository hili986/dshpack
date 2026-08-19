import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { type CommandReport, diagnostic, resolveDshHomeValue } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { assertPortableSnapshotEntries } from '../install/snapshot-path.js';
import {
  bindSecureRoot,
  type DirectoryBinding,
  readBytes,
  readDirectory,
  revalidateDirectoryEntries,
  revalidateFileSnapshot,
  type SafeFileSnapshot,
  type SafePathHooks,
} from '../list/safe-fs.js';
import {
  isCanonicalSha256Sri,
  isInstallableProfileName,
  isValidSettingsContribution,
  parseInstalledMetadata,
} from '../metadata/contracts.js';
import { isCanonicalCasStoreShard } from '../metadata/state-storage.js';
import {
  createNodeTransactionAdapter,
  MAX_TRANSACTION_STATE_BYTES,
  type ReplaceJournalAction,
  runTransaction,
  type TransactionAdapter,
  TransactionFailure,
  type TransactionJournal,
  TransactionPhysicalProgressError,
  TransactionStateReadLimitError,
  TransactionStateReadSecurityError,
} from '../transaction.js';
import { actionId, serializeJournal } from '../transaction-journal.js';

const DEFAULT_KEEP = 10;
const CURRENT_MAX_BYTES = 128;
const STORE_PREFIX = /^[A-Za-z0-9_-]{2}$/u;

export interface GcInput {
  dshHome: string;
  keep?: number;
  dryRun: boolean;
}

/**
 * Narrow runtime seams used to prove that collection revalidates its complete
 * plan after it owns the transaction lease. They are intentionally unavailable
 * from the CLI command surface.
 */
export interface GcDependencies {
  createAdapter?: () => TransactionAdapter;
  createTxid?: () => string;
  onBeforeLockedScan?: () => Promise<void>;
  /** Test-only safe filesystem seam for stable scan TOCTOU coverage. */
  safePathHooks?: SafePathHooks;
  /** Test-only override proving GC never creates a journal readers cannot reopen. */
  maxJournalBytes?: number;
  /** Test-only canonical-root binder used to prove Windows alias handling without a Windows host. */
  bindRoot?: typeof bindSecureRoot;
}

export interface GcMetadata {
  dryRun: boolean;
  keep: number;
  deletedGenerations: readonly string[];
  deletedBlocks: readonly string[];
  /** Active state was committed, but immutable quarantine bytes still need a later GC retry. */
  pendingPurge: boolean;
  manualRecovery: readonly unknown[];
}

export type GcReport = CommandReport<GcMetadata>;

interface PlannedStateFile {
  path: string;
  relative: string;
  sha256: string;
  identity: string;
}

interface GenerationManifest extends PlannedStateFile {
  profile: string;
  sequence: number;
  restorable: boolean;
  entries: readonly { target: string; sha256: string }[];
}

interface GcPlan {
  deletedGenerations: readonly GenerationManifest[];
  deletedBlocks: readonly PlannedStateFile[];
}

interface GcQuarantineFile extends PlannedStateFile {
  actionId: string;
}

/** A GC/purge failure with an explicit recovery classification for callers sharing its purge phase. */
export class GcFailure extends Error {
  constructor(
    readonly exitCode: ExitCode,
    readonly code: string,
    message: string,
    readonly manualRecovery: readonly unknown[] = [],
    /** A post-commit purge already made an irreversible physical change before this failure. */
    readonly physicalProgress = false,
  ) {
    super(message);
    this.name = 'GcFailure';
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function fail(exitCode: ExitCode, code: string, message: string): never {
  throw new GcFailure(exitCode, code, message);
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === '';
}

function isGcTransactionId(value: string): boolean {
  return /^gc-[A-Za-z0-9][A-Za-z0-9._-]{0,124}$/u.test(value);
}

function isUninstallPurgeTransactionId(value: string): boolean {
  return /^uninstall-purge-[A-Za-z0-9][A-Za-z0-9._-]{0,111}$/u.test(value);
}

function isStatePurgeTransactionId(value: string): boolean {
  return isGcTransactionId(value) || isUninstallPurgeTransactionId(value);
}

function isCanonicalActionId(value: string): boolean {
  const match = /^action-(\d+)$/u.exec(value);
  if (match === null) return false;
  const number = Number(match[1]);
  return (
    Number.isSafeInteger(number) &&
    number > 0 &&
    value === `action-${String(number).padStart(4, '0')}`
  );
}

function gcQuarantineActionId(leaf: string): string | undefined {
  if (isCanonicalActionId(leaf)) return leaf;
  const match = /^(action-\d+)\.purging-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.exec(leaf);
  const actionId = match?.[1];
  return actionId !== undefined && isCanonicalActionId(actionId) ? actionId : undefined;
}

function canonicalGenerationSequence(name: string): number | undefined {
  const match = /^(\d+)\.json$/u.exec(name);
  if (match === null) return undefined;
  const sequence = Number(match[1]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
  return name === `${String(sequence).padStart(4, '0')}.json` ? sequence : undefined;
}

/**
 * Validate only the invariant filename shape here.  Root ownership is checked later through
 * canonical directory bindings; lexical root comparisons would reject Windows 8.3 aliases.
 */
function journalArtifactPathShape(artifact: unknown, path: string): boolean {
  const leaf = basename(path);
  if (artifact === 'store-block') {
    const prefix = basename(dirname(path));
    return (
      isCanonicalSha256Sri(leaf) &&
      STORE_PREFIX.test(prefix) &&
      isCanonicalCasStoreShard(prefix, leaf)
    );
  }
  return (
    (artifact === 'generation' || artifact === 'generation-current') &&
    isInstallableProfileName(basename(dirname(path))) &&
    (artifact === 'generation-current'
      ? leaf === 'current'
      : canonicalGenerationSequence(leaf) !== undefined)
  );
}

/**
 * Journal actions must retain their original lexical provenance before their declared roots are
 * bound canonically.  A valid digest basename by itself does not authorize an arbitrary absolute
 * path, and the backup slot is deterministic so a journal cannot point recovery at another slot.
 * Keeping this lexical relation first also permits a long/8.3 alias as long as every recorded
 * action uses the journal's own spelling; `assertGcQuarantineJournalScope` then binds it safely.
 */
function journalActionPathsMatch(
  dshHome: string,
  backupDirectory: string,
  artifact: unknown,
  actionId: unknown,
  oldPath: string,
  preservedAt: string,
): boolean {
  if (typeof actionId !== 'string' || !isCanonicalActionId(actionId)) return false;
  if (!journalArtifactPathShape(artifact, oldPath)) return false;
  const leaf = basename(oldPath);
  const expectedOld =
    artifact === 'store-block'
      ? join(dshHome, '.dshpack', 'store', basename(dirname(oldPath)), leaf)
      : artifact === 'generation' || artifact === 'generation-current'
        ? join(dshHome, '.dshpack', 'generations', basename(dirname(oldPath)), leaf)
        : undefined;
  return (
    expectedOld !== undefined &&
    oldPath === expectedOld &&
    preservedAt === join(backupDirectory, 'old', actionId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGenerationDocument(
  bytes: Buffer,
  profile: string,
  expectedSequence: number,
): {
  restorable: boolean;
  entries: readonly { target: string; sha256: string }[];
} {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes))
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_GENERATION_DOCUMENT',
      'generation document is not valid UTF-8.',
    );
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(EXIT_CODES.CONTRACT, 'E_GC_GENERATION_DOCUMENT', 'generation document is not valid JSON.');
  }
  if (!isRecord(value) || value.seq !== expectedSequence || typeof value.txid !== 'string') {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_GENERATION_DOCUMENT',
      'generation document has an invalid identity.',
    );
  }
  if (
    typeof value.createdAt !== 'string' ||
    (value.operation !== 'install' &&
      value.operation !== 'update' &&
      value.operation !== 'uninstall' &&
      value.operation !== 'restore')
  ) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_GENERATION_DOCUMENT',
      'generation document has invalid operation metadata.',
    );
  }
  if (
    !isRecord(value.pack) ||
    typeof value.pack.name !== 'string' ||
    typeof value.pack.version !== 'string' ||
    typeof value.pack.manifestDigest !== 'string' ||
    !isCanonicalSha256Sri(value.pack.manifestDigest) ||
    !isRecord(value.source) ||
    typeof value.restorable !== 'boolean'
  ) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_GENERATION_DOCUMENT',
      'generation document has an invalid required field.',
    );
  }
  if (!isValidSettingsContribution(value.settingsContribution)) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_GENERATION_DOCUMENT',
      'generation settings contribution is invalid.',
    );
  }
  if (value.metadata === null) {
    if (value.operation !== 'uninstall' && value.operation !== 'restore')
      fail(
        EXIT_CODES.CONTRACT,
        'E_GC_GENERATION_DOCUMENT',
        'generation metadata does not describe its effective marker state.',
      );
  } else {
    const metadata = parseInstalledMetadata(value.metadata, profile);
    if (
      !metadata.ok ||
      metadata.metadata.metadataVersion !== 1 ||
      value.operation === 'uninstall' ||
      metadata.metadata.generation !== expectedSequence ||
      JSON.stringify(metadata.metadata.settingsContribution) !==
        JSON.stringify(value.settingsContribution)
    )
      fail(
        EXIT_CODES.CONTRACT,
        'E_GC_GENERATION_DOCUMENT',
        'generation metadata does not describe its effective marker state.',
      );
  }
  if (!Array.isArray(value.entries))
    fail(EXIT_CODES.CONTRACT, 'E_GC_GENERATION_DOCUMENT', 'generation entries are invalid.');
  const targets = new Set<string>();
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.target !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !isCanonicalSha256Sri(entry.sha256)
    ) {
      fail(EXIT_CODES.CONTRACT, 'E_GC_GENERATION_DOCUMENT', 'generation entry is invalid.');
    }
    if (targets.has(entry.target))
      fail(
        EXIT_CODES.CONTRACT,
        'E_GC_GENERATION_DOCUMENT',
        'generation entry targets are not unique.',
      );
    targets.add(entry.target);
    return { target: entry.target, sha256: entry.sha256 };
  });
  try {
    assertPortableSnapshotEntries(entries.map((entry) => ({ path: entry.target, kind: 'file' })));
  } catch {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_GENERATION_DOCUMENT',
      'generation entries are not portable snapshot paths.',
    );
  }
  return { entries, restorable: value.restorable };
}

function parseCurrent(bytes: Buffer): number {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || !/^[1-9]\d*\n$/u.test(text)) {
    fail(EXIT_CODES.CONTRACT, 'E_GC_CURRENT', 'generation current pointer is invalid.');
  }
  const sequence = Number(text.slice(0, -1));
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_CURRENT',
      'generation current pointer is outside the safe range.',
    );
  return sequence;
}

interface ParsedGcQuarantineJournal {
  state: 'committed' | 'rolled-back';
  purpose: 'gc' | 'uninstall-purge';
  actions: readonly GcQuarantineFile[];
  actionIds: ReadonlySet<string>;
  dshHome: string;
  backupDirectory: string;
}

function parseGcQuarantineJournal(
  dshHome: string,
  txid: string,
  bytes: Buffer,
): ParsedGcQuarantineJournal {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_QUARANTINE_JOURNAL',
      'GC quarantine journal is not valid UTF-8.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_QUARANTINE_JOURNAL',
      'GC quarantine journal is not valid JSON.',
    );
  }
  if (
    !isRecord(value) ||
    value.version !== 0 ||
    (value.purpose !== 'gc' && value.purpose !== 'uninstall-purge') ||
    value.txid !== txid ||
    typeof value.dshHome !== 'string' ||
    !isAbsolute(value.dshHome) ||
    typeof value.backupDirectory !== 'string' ||
    !isAbsolute(value.backupDirectory) ||
    !Array.isArray(value.actions)
  ) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_QUARANTINE_JOURNAL',
      'GC quarantine journal is not a valid GC transaction.',
    );
  }
  if (value.state === 'rolled-back') {
    return {
      state: 'rolled-back',
      purpose: value.purpose,
      actions: [],
      actionIds: new Set(),
      dshHome: value.dshHome,
      backupDirectory: value.backupDirectory,
    };
  }
  if (
    value.state === 'active' ||
    value.state === 'rolling-back' ||
    value.state === 'rollback-failed'
  ) {
    throw new GcFailure(
      EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      'E_GC_QUARANTINE_RECOVERY',
      'GC found an interrupted quarantine transaction that requires manual recovery.',
      [
        {
          actionId: 'quarantine-journal',
          operation: 'inspect-lock',
          sourcePath: join(dshHome, '.dshpack', 'backups', txid, 'journal.json'),
          destinationPath: join(dshHome, '.dshpack', 'backups', txid),
          reason: `journal state is ${value.state}`,
        },
      ],
    );
  }
  if (value.state !== 'committed') {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_QUARANTINE_JOURNAL',
      'GC quarantine journal is not committed or cleanly rolled back.',
    );
  }
  const actionIds = new Set<string>();
  for (const action of value.actions) {
    if (!isRecord(action) || typeof action.id !== 'string' || !isCanonicalActionId(action.id)) {
      fail(EXIT_CODES.CONTRACT, 'E_GC_QUARANTINE_JOURNAL', 'GC quarantine action is invalid.');
    }
    if (actionIds.has(action.id)) {
      fail(
        EXIT_CODES.CONTRACT,
        'E_GC_QUARANTINE_JOURNAL',
        'GC quarantine action id is duplicated.',
      );
    }
    actionIds.add(action.id);
  }
  const eligible = value.actions.filter(
    (action) =>
      isRecord(action) &&
      action.kind === 'replace' &&
      action.phase === 'applied' &&
      (action.artifact === 'store-block' ||
        action.artifact === 'generation' ||
        action.artifact === 'generation-current'),
  );
  if (value.purpose === 'gc' && eligible.length !== value.actions.length) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_QUARANTINE_JOURNAL',
      'GC quarantine journal has a non-state collection action.',
    );
  }
  const stateActionIds = new Set<string>();
  const actions = eligible.map((action, index) => {
    if (
      !isRecord(action) ||
      action.kind !== 'replace' ||
      action.phase !== 'applied' ||
      (action.artifact !== 'store-block' &&
        action.artifact !== 'generation' &&
        action.artifact !== 'generation-current') ||
      typeof action.id !== 'string' ||
      !isCanonicalActionId(action.id) ||
      !isRecord(action.old) ||
      !isRecord(action.new) ||
      typeof action.old.identity !== 'string' ||
      !/^\d+:\d+:\d+$/u.test(action.old.identity) ||
      typeof action.old.path !== 'string' ||
      !isAbsolute(action.old.path) ||
      typeof action.old.contentSha256 !== 'string' ||
      !isCanonicalSha256Sri(action.old.contentSha256) ||
      typeof action.new.preservedAt !== 'string' ||
      !isAbsolute(action.new.preservedAt) ||
      !isCanonicalActionId(basename(action.new.preservedAt)) ||
      !journalActionPathsMatch(
        value.dshHome as string,
        value.backupDirectory as string,
        action.artifact,
        action.id as string,
        action.old.path,
        action.new.preservedAt,
      )
    ) {
      fail(
        EXIT_CODES.CONTRACT,
        'E_GC_QUARANTINE_JOURNAL',
        `GC quarantine journal action ${String(index)} is invalid.`,
      );
    }
    if (stateActionIds.has(action.id)) {
      fail(
        EXIT_CODES.CONTRACT,
        'E_GC_QUARANTINE_JOURNAL',
        `GC quarantine journal action ${String(index)} duplicates an action id.`,
      );
    }
    stateActionIds.add(action.id);
    const path = join(dshHome, '.dshpack', 'backups', txid, 'old', action.id);
    return {
      actionId: action.id,
      path,
      relative: join('.dshpack', 'backups', txid, 'old', action.id),
      sha256: action.old.contentSha256,
      identity: action.old.identity,
    };
  });
  return {
    state: 'committed',
    purpose: value.purpose,
    actions,
    actionIds,
    dshHome: value.dshHome,
    backupDirectory: value.backupDirectory,
  };
}

async function assertGcQuarantineJournalScope(
  home: DirectoryBinding,
  journal: ParsedGcQuarantineJournal,
  txid: string,
  bindRoot: typeof bindSecureRoot = bindSecureRoot,
): Promise<void> {
  const declaredHome = await bindRoot(journal.dshHome);
  const expectedBackup = await bindRoot(join(home.rootPath, '.dshpack', 'backups', txid));
  const declaredBackup = await bindRoot(journal.backupDirectory);
  if (
    !declaredHome.ok ||
    !expectedBackup.ok ||
    !declaredBackup.ok ||
    !samePath(declaredHome.value.rootCanonical, home.rootCanonical) ||
    !samePath(declaredBackup.value.rootCanonical, expectedBackup.value.rootCanonical)
  ) {
    fail(
      EXIT_CODES.SECURITY,
      'E_GC_QUARANTINE_SCOPE',
      'GC quarantine journal paths do not bind to this secure DSH_HOME.',
    );
  }
}

function safeReadFailure(
  kind: 'missing' | 'security' | 'io' | 'limit' | 'changed',
  scope: string,
): never {
  if (kind === 'security')
    fail(EXIT_CODES.SECURITY, 'E_GC_STATE_SECURITY', `GC refused an unsafe ${scope} path.`);
  if (kind === 'limit')
    fail(EXIT_CODES.CONTRACT, 'E_GC_STATE_READ_LIMIT', `GC ${scope} exceeds its safe read limit.`);
  if (kind === 'changed')
    fail(EXIT_CODES.CONTRACT, 'E_GC_STATE_CHANGED', `GC ${scope} changed during stable scanning.`);
  if (kind === 'io')
    fail(EXIT_CODES.INTERNAL, 'E_GC_STATE_READ', `GC cannot read ${scope} safely.`);
  fail(EXIT_CODES.CONTRACT, 'E_GC_STATE_MISSING', `GC found missing ${scope} state.`);
}

function failureReport(input: GcInput, error: unknown): CommandReport<GcMetadata> {
  const keep =
    input.keep !== undefined && Number.isSafeInteger(input.keep) && input.keep >= 0
      ? input.keep
      : DEFAULT_KEEP;
  const failure =
    error instanceof GcFailure
      ? error
      : new GcFailure(EXIT_CODES.INTERNAL, 'E_GC_INTERNAL', 'GC failed unexpectedly.');
  return {
    diagnostics: [
      diagnostic(
        failure.code,
        'error',
        failure.message,
        'Repair the generation store and retry; no collection plan was applied.',
      ),
    ],
    exitCode: failure.exitCode,
    metadata: {
      dryRun: input.dryRun,
      keep,
      deletedGenerations: [],
      deletedBlocks: [],
      pendingPurge: false,
      manualRecovery: failure.manualRecovery,
    },
  };
}

function pendingPurgeReport(
  input: GcInput,
  plan: GcPlan,
  error: unknown,
): CommandReport<GcMetadata> {
  if (error instanceof GcFailure && error.manualRecovery.length > 0)
    return failureReport(input, error);
  const cause =
    error instanceof GcFailure
      ? error
      : new GcFailure(
          EXIT_CODES.INTERNAL,
          'E_GC_QUARANTINE_PURGE',
          'GC quarantine purge could not complete.',
        );
  return {
    diagnostics: [
      diagnostic(
        cause.code,
        'warning',
        `GC committed active-state collection, but physical reclamation is pending: ${cause.message}`,
        'Run dshpack gc again after resolving this state condition; active collection is committed, but no physical reclamation is claimed until verified purge succeeds.',
      ),
    ],
    exitCode: EXIT_CODES.SUCCESS,
    metadata: metadata(input, plan, [], true),
  };
}

function metadata(
  input: GcInput,
  plan: GcPlan,
  manualRecovery: readonly unknown[] = [],
  pendingPurge = false,
): GcMetadata {
  return {
    dryRun: input.dryRun,
    keep: input.keep ?? DEFAULT_KEEP,
    deletedGenerations: plan.deletedGenerations.map(({ relative }) => relative),
    deletedBlocks: plan.deletedBlocks.map(({ sha256: digest }) => digest),
    pendingPurge,
    manualRecovery,
  };
}

function assertKeep(value: number | undefined): number {
  const keep = value ?? DEFAULT_KEEP;
  if (!Number.isSafeInteger(keep) || keep < 0)
    fail(EXIT_CODES.CONTRACT, 'E_GC_KEEP', 'GC keep must be a non-negative safe integer.');
  return keep;
}

async function scanPlan(
  dshHome: string,
  keep: number,
  hooks: SafePathHooks = {},
  revalidateCompleteScan = false,
  bindRoot: typeof bindSecureRoot = bindSecureRoot,
): Promise<GcPlan> {
  const home = await bindRoot(dshHome);
  if (!home.ok) {
    if (home.kind === 'security')
      fail(EXIT_CODES.SECURITY, 'E_GC_DSH_HOME', 'GC refused an unsafe DSH_HOME path.');
    fail(EXIT_CODES.ENVIRONMENT, 'E_GC_DSH_HOME', 'GC cannot open DSH_HOME.');
  }
  const snapshots: { binding: DirectoryBinding; entries: readonly Dirent<string>[] }[] = [];
  const fileSnapshots: SafeFileSnapshot[] = [];
  const scanHooks: SafePathHooks = {
    ...hooks,
    afterDirectorySnapshot: async (binding, entries) => {
      snapshots.push({ binding, entries });
      await hooks.afterDirectorySnapshot?.(binding, entries);
    },
  };
  const generationRoot = await readDirectory(home.value, ['.dshpack', 'generations'], scanHooks);
  const profiles = generationRoot.ok
    ? generationRoot.value
    : generationRoot.kind === 'missing'
      ? []
      : safeReadFailure(generationRoot.kind, 'generation root');
  const manifests: GenerationManifest[] = [];
  const retained = new Set<GenerationManifest>();
  for (const profileEntry of [...profiles].sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  )) {
    if (!profileEntry.isDirectory() || profileEntry.isSymbolicLink())
      fail(
        EXIT_CODES.SECURITY,
        'E_GC_GENERATION_LAYOUT',
        'generation root contains an unsafe entry.',
      );
    const profile = profileEntry.name;
    if (!isInstallableProfileName(profile))
      fail(EXIT_CODES.SECURITY, 'E_GC_PROFILE', 'generation root contains an unsafe profile name.');
    const contents = await readDirectory(
      home.value,
      ['.dshpack', 'generations', profile],
      scanHooks,
    );
    if (!contents.ok) safeReadFailure(contents.kind, 'profile generation directory');
    const bySequence = new Map<number, GenerationManifest>();
    let currentFound = false;
    let current = 0;
    for (const entry of [...contents.value].sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      if (entry.name === 'current') {
        if (!entry.isFile() || entry.isSymbolicLink())
          fail(EXIT_CODES.SECURITY, 'E_GC_CURRENT', 'generation current is not a regular file.');
        const pointer = await readBytes(
          home.value,
          ['.dshpack', 'generations', profile, 'current'],
          scanHooks,
          CURRENT_MAX_BYTES,
        );
        if (!pointer.ok) safeReadFailure(pointer.kind, 'generation current');
        fileSnapshots.push({
          segments: ['.dshpack', 'generations', profile, 'current'],
          identity: pointer.value.identity,
          sha256: sha256(pointer.value.bytes),
          size: pointer.value.bytes.byteLength,
          maximumBytes: CURRENT_MAX_BYTES,
        });
        current = parseCurrent(pointer.value.bytes);
        currentFound = true;
        continue;
      }
      const sequence = canonicalGenerationSequence(entry.name);
      if (sequence === undefined || !entry.isFile() || entry.isSymbolicLink())
        fail(
          EXIT_CODES.SECURITY,
          'E_GC_GENERATION_LAYOUT',
          'generation directory contains an unsafe entry.',
        );
      const document = await readBytes(
        home.value,
        ['.dshpack', 'generations', profile, entry.name],
        scanHooks,
        MAX_TRANSACTION_STATE_BYTES,
      );
      if (!document.ok) safeReadFailure(document.kind, 'generation document');
      fileSnapshots.push({
        segments: ['.dshpack', 'generations', profile, entry.name],
        identity: document.value.identity,
        sha256: sha256(document.value.bytes),
        size: document.value.bytes.byteLength,
        maximumBytes: MAX_TRANSACTION_STATE_BYTES,
      });
      const parsed = parseGenerationDocument(document.value.bytes, profile, sequence);
      const relative = join('.dshpack', 'generations', profile, entry.name);
      const manifest: GenerationManifest = {
        path: join(dshHome, relative),
        relative,
        sha256: sha256(document.value.bytes),
        identity: document.value.identity,
        profile,
        sequence,
        restorable: parsed.restorable,
        entries: parsed.entries,
      };
      if (bySequence.has(sequence))
        fail(EXIT_CODES.CONTRACT, 'E_GC_GENERATION_LAYOUT', 'generation sequence is duplicated.');
      bySequence.set(sequence, manifest);
      manifests.push(manifest);
    }
    if (bySequence.size === 0) {
      if (currentFound)
        fail(EXIT_CODES.CONTRACT, 'E_GC_CURRENT', 'current points to an absent generation.');
      continue;
    }
    if (!currentFound || !bySequence.has(current))
      fail(EXIT_CODES.CONTRACT, 'E_GC_CURRENT', 'current points to an absent generation.');
    const newest = [...bySequence.values()]
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, keep);
    for (const generation of newest) retained.add(generation);
    retained.add(bySequence.get(current) as GenerationManifest);
  }
  const live = new Set<string>();
  const required = new Set<string>();
  for (const generation of retained) {
    for (const entry of generation.entries) {
      live.add(entry.sha256);
      if (generation.restorable) required.add(entry.sha256);
    }
  }

  const storeRoot = await readDirectory(home.value, ['.dshpack', 'store'], scanHooks);
  const prefixes = storeRoot.ok
    ? storeRoot.value
    : storeRoot.kind === 'missing'
      ? []
      : safeReadFailure(storeRoot.kind, 'CAS store root');
  const blocks: PlannedStateFile[] = [];
  for (const prefixEntry of [...prefixes].sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  )) {
    if (
      !prefixEntry.isDirectory() ||
      prefixEntry.isSymbolicLink() ||
      !STORE_PREFIX.test(prefixEntry.name) ||
      prefixEntry.name !== prefixEntry.name.toLowerCase()
    )
      fail(EXIT_CODES.SECURITY, 'E_GC_STORE_LAYOUT', 'CAS store contains an unsafe prefix entry.');
    const contents = await readDirectory(
      home.value,
      ['.dshpack', 'store', prefixEntry.name],
      scanHooks,
    );
    if (!contents.ok) safeReadFailure(contents.kind, 'CAS prefix directory');
    for (const entry of [...contents.value].sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        !isCanonicalSha256Sri(entry.name) ||
        !isCanonicalCasStoreShard(prefixEntry.name, entry.name)
      )
        fail(EXIT_CODES.SECURITY, 'E_GC_STORE_LAYOUT', 'CAS store contains an unsafe block entry.');
      const block = await readBytes(
        home.value,
        ['.dshpack', 'store', prefixEntry.name, entry.name],
        scanHooks,
        MAX_TRANSACTION_STATE_BYTES,
      );
      if (!block.ok) safeReadFailure(block.kind, 'CAS block');
      fileSnapshots.push({
        segments: ['.dshpack', 'store', prefixEntry.name, entry.name],
        identity: block.value.identity,
        sha256: sha256(block.value.bytes),
        size: block.value.bytes.byteLength,
        maximumBytes: MAX_TRANSACTION_STATE_BYTES,
      });
      if (sha256(block.value.bytes) !== entry.name)
        fail(
          EXIT_CODES.CONTRACT,
          'E_GC_STORE_DIGEST',
          'CAS block bytes do not match their digest name.',
        );
      blocks.push({
        path: join(dshHome, '.dshpack', 'store', prefixEntry.name, entry.name),
        relative: join('.dshpack', 'store', prefixEntry.name, entry.name),
        sha256: entry.name,
        identity: block.value.identity,
      });
    }
  }
  const available = new Set(blocks.map(({ sha256: digest }) => digest));
  for (const digest of required) {
    if (!available.has(digest))
      fail(
        EXIT_CODES.CONTRACT,
        'E_GC_STORE_MISSING',
        'a retained generation references a missing CAS block.',
      );
  }
  const plan = {
    deletedGenerations: manifests
      .filter((generation) => !retained.has(generation))
      .sort((left, right) => left.relative.localeCompare(right.relative, 'en')),
    deletedBlocks: blocks
      .filter((block) => !live.has(block.sha256))
      .sort((left, right) => left.sha256.localeCompare(right.sha256, 'en')),
  };
  if (revalidateCompleteScan) {
    for (const snapshot of snapshots) {
      const stable = await revalidateDirectoryEntries(
        snapshot.binding,
        snapshot.entries,
        scanHooks,
      );
      if (!stable.ok) safeReadFailure(stable.kind, 'managed-state directory');
    }
    for (const snapshot of fileSnapshots) {
      const stable = await revalidateFileSnapshot(home.value, snapshot, scanHooks);
      if (!stable.ok) safeReadFailure(stable.kind, 'managed-state file');
    }
  }
  return plan;
}

/** Read committed GC payloads left behind by a previous successful transaction without mutating. */
async function scanGcQuarantine(
  dshHome: string,
  bindRoot: typeof bindSecureRoot = bindSecureRoot,
  onlyTxid?: string,
): Promise<readonly GcQuarantineFile[]> {
  const home = await bindRoot(dshHome);
  if (!home.ok) {
    if (home.kind === 'security')
      fail(EXIT_CODES.SECURITY, 'E_GC_DSH_HOME', 'GC refused an unsafe DSH_HOME path.');
    fail(EXIT_CODES.ENVIRONMENT, 'E_GC_DSH_HOME', 'GC cannot open DSH_HOME.');
  }
  const backups = await readDirectory(home.value, ['.dshpack', 'backups']);
  const entries = backups.ok
    ? backups.value
    : backups.kind === 'missing'
      ? []
      : safeReadFailure(backups.kind, 'GC quarantine root');
  const payloads: GcQuarantineFile[] = [];
  let foundRequestedTransaction = onlyTxid === undefined;
  for (const entry of [...entries].sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  )) {
    if (onlyTxid !== undefined && entry.name !== onlyTxid) continue;
    foundRequestedTransaction = true;
    if (!entry.name.startsWith('gc-') && !entry.name.startsWith('uninstall-purge-')) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isStatePurgeTransactionId(entry.name)) {
      fail(
        EXIT_CODES.SECURITY,
        'E_GC_QUARANTINE_LAYOUT',
        'GC quarantine contains an unsafe entry.',
      );
    }
    const journal = await readBytes(
      home.value,
      ['.dshpack', 'backups', entry.name, 'journal.json'],
      {},
      MAX_TRANSACTION_STATE_BYTES,
    );
    if (!journal.ok) safeReadFailure(journal.kind, 'GC quarantine journal');
    const parsed = parseGcQuarantineJournal(dshHome, entry.name, journal.value.bytes);
    await assertGcQuarantineJournalScope(home.value, parsed, entry.name, bindRoot);
    const old = await readDirectory(home.value, ['.dshpack', 'backups', entry.name, 'old']);
    if (!old.ok) {
      if (old.kind === 'missing') continue;
      safeReadFailure(old.kind, 'GC quarantine payload directory');
    }
    if (parsed.state === 'rolled-back') {
      if (old.value.length !== 0) {
        fail(
          EXIT_CODES.CONTRACT,
          'E_GC_QUARANTINE_JOURNAL',
          'a cleanly rolled-back GC journal still contains owned payloads.',
        );
      }
      continue;
    }
    const namesByAction = new Map<string, string>();
    const actionsById = new Map(parsed.actions.map((action) => [action.actionId, action]));
    for (const payload of old.value) {
      const actionId = gcQuarantineActionId(payload.name);
      if (actionId === undefined || !parsed.actionIds.has(actionId)) {
        fail(
          EXIT_CODES.CONTRACT,
          'E_GC_QUARANTINE_JOURNAL',
          'GC quarantine payload directory has an invalid action slot.',
        );
      }
      // Uninstall-purge journals also back up user artifacts and marker/settings documents.
      // They remain recoverable; only immutable state deletion payloads are eligible for this
      // second permanent collection phase.
      if (!actionsById.has(actionId)) continue;
      if (!payload.isFile() || payload.isSymbolicLink() || namesByAction.has(actionId)) {
        fail(
          EXIT_CODES.CONTRACT,
          'E_GC_QUARANTINE_JOURNAL',
          'GC quarantine state payload directory has an invalid action slot.',
        );
      }
      namesByAction.set(actionId, payload.name);
    }
    for (const action of parsed.actions) {
      const leaf = namesByAction.get(action.actionId);
      if (leaf === undefined) continue;
      const state = await readBytes(
        home.value,
        ['.dshpack', 'backups', entry.name, 'old', leaf],
        {},
        MAX_TRANSACTION_STATE_BYTES,
      );
      if (!state.ok) {
        if (state.kind === 'missing') continue;
        safeReadFailure(state.kind, 'GC quarantine payload');
      }
      if (state.value.identity !== action.identity || sha256(state.value.bytes) !== action.sha256) {
        fail(
          EXIT_CODES.CONTRACT,
          'E_GC_QUARANTINE_CHANGED',
          'GC quarantine payload bytes no longer match their committed digest.',
        );
      }
      payloads.push({
        ...action,
        path: join(dshHome, '.dshpack', 'backups', entry.name, 'old', leaf),
        relative: join('.dshpack', 'backups', entry.name, 'old', leaf),
      });
    }
  }
  if (!foundRequestedTransaction)
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_QUARANTINE_JOURNAL',
      'committed state-collection quarantine is missing.',
    );
  return payloads;
}

function stateReadFailure(error: unknown): never {
  if (error instanceof GcFailure) throw error;
  if (error instanceof TransactionPhysicalProgressError) {
    throw new GcFailure(
      EXIT_CODES.INTERNAL,
      'E_GC_QUARANTINE_PURGE',
      'GC quarantine payload changed physically but its durability confirmation failed.',
      [],
      true,
    );
  }
  if (error instanceof TransactionStateReadLimitError) {
    fail(EXIT_CODES.CONTRACT, 'E_GC_STATE_READ_LIMIT', 'GC state exceeds its safe read limit.');
  }
  if (error instanceof TransactionStateReadSecurityError) {
    fail(EXIT_CODES.SECURITY, 'E_GC_STATE_SECURITY', 'GC refused an unsafe state file.');
  }
  if (error instanceof TransactionFailure) {
    const first = error.diagnostics[0];
    fail(
      error.exitCode,
      first?.code ?? 'E_GC_QUARANTINE_PURGE',
      first?.message ?? 'GC quarantine purge failed.',
    );
  }
  throw error;
}

/**
 * A committed transaction first keeps deleted bytes in `old` so rollback remains possible.
 * This second, lease-protected phase removes only payloads proven identical to that journal.
 */
export async function purgeCommittedStateQuarantine(
  dshHome: string,
  adapter: TransactionAdapter,
  onlyTxid?: string,
  bindRoot: typeof bindSecureRoot = bindSecureRoot,
): Promise<void> {
  const observed = await scanGcQuarantine(dshHome, bindRoot, onlyTxid);
  if (observed.length === 0) return;
  let lock: Awaited<ReturnType<TransactionAdapter['acquireArtifactLock']>> | undefined;
  let failure: unknown;
  let removed = 0;
  try {
    lock = await adapter.acquireArtifactLock(dshHome);
    const locked = await scanGcQuarantine(dshHome, bindRoot, onlyTxid);
    if (adapter.purgeGcQuarantineFile === undefined) {
      fail(
        EXIT_CODES.INTERNAL,
        'E_GC_QUARANTINE_PURGE',
        'transaction adapter cannot purge a verified GC quarantine payload.',
      );
    }
    for (const payload of locked) {
      if (
        !(await adapter.purgeGcQuarantineFile(lock, payload.path, payload.sha256, payload.identity))
      ) {
        fail(
          EXIT_CODES.CONTRACT,
          'E_GC_QUARANTINE_CHANGED',
          'GC quarantine payload changed before verified permanent removal.',
        );
      }
      removed += 1;
    }
  } catch (error) {
    failure = error;
  }
  let releaseFailure: unknown;
  if (lock !== undefined) {
    try {
      await lock.release();
    } catch (error) {
      releaseFailure = error;
    }
  }
  if (releaseFailure !== undefined && lock !== undefined) {
    throw new GcFailure(
      EXIT_CODES.MANUAL_RECOVERY_REQUIRED,
      'E_GC_QUARANTINE_LOCK_RELEASE',
      'GC quarantine purge completed but its artifact lock could not be released.',
      [
        {
          actionId: 'artifact-lock',
          operation: 'inspect-lock',
          sourcePath: lock.lockPath,
          destinationPath: lock.lockPath,
          reason: releaseFailure instanceof Error ? releaseFailure.message : String(releaseFailure),
        },
      ],
    );
  }
  if (failure !== undefined) {
    try {
      stateReadFailure(failure);
    } catch (error) {
      if (error instanceof GcFailure && removed > 0) {
        throw new GcFailure(error.exitCode, error.code, error.message, error.manualRecovery, true);
      }
      throw error;
    }
  }
}

function samePlan(left: GcPlan, right: GcPlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function journalBytesForDeleteBatch(
  dshHome: string,
  txid: string,
  candidates: readonly {
    file: PlannedStateFile;
    artifact: 'generation' | 'store-block';
  }[],
): number {
  const backupDirectory = join(dshHome, '.dshpack', 'backups', txid);
  const actions: ReplaceJournalAction[] = candidates.map((candidate, index) => {
    const id = actionId(index + 1);
    return {
      id,
      kind: 'replace',
      artifact: candidate.artifact,
      phase: 'planned',
      old: {
        path: candidate.file.path,
        exists: true,
        identity: candidate.file.identity,
        contentSha256: candidate.file.sha256,
      },
      new: {
        path: candidate.file.path,
        exists: false,
        preservedAt: join(backupDirectory, 'old', id),
      },
    };
  });
  const journal: TransactionJournal = {
    version: 0,
    txid,
    purpose: 'gc',
    dshHome,
    backupDirectory,
    state: 'active',
    actions,
  };
  // The first durable journal is `active/planned`, but it is retained for GC recovery in every
  // terminal state.  Size the batch against the largest exact serialization so a committed or
  // rollback-failed journal can always be reopened by the same bounded reader.
  const terminalForms = [
    { state: 'active' as const, phase: 'planned' as const },
    { state: 'committed' as const, phase: 'applied' as const },
    { state: 'rolling-back' as const, phase: 'rollback-failed' as const },
    { state: 'rolled-back' as const, phase: 'rolled-back' as const },
    { state: 'rollback-failed' as const, phase: 'rollback-failed' as const },
  ];
  return Math.max(
    ...terminalForms.map(({ state, phase }) =>
      Buffer.byteLength(
        serializeJournal({
          ...journal,
          state,
          actions: actions.map((action) => ({ ...action, phase })),
        }),
        'utf8',
      ),
    ),
  );
}

/**
 * Deleting a generation and its CAS blocks in the same truncated journal is unsafe: another
 * obsolete generation outside the first batch can still reference that block.  Therefore every
 * generation batch runs alone; a later GC rescans all survivors before it is allowed to collect
 * blocks.  Binary search uses the real serialized journal size without O(n²) trial construction.
 */
function selectGcBatch(dshHome: string, txid: string, plan: GcPlan, maximumBytes: number): GcPlan {
  const generationFirst = plan.deletedGenerations.length > 0;
  const full = [
    ...plan.deletedGenerations.map((file) => ({ file, artifact: 'generation' as const })),
    ...plan.deletedBlocks.map((file) => ({ file, artifact: 'store-block' as const })),
  ];
  if (full.length > 0 && journalBytesForDeleteBatch(dshHome, txid, full) <= maximumBytes)
    return plan;
  const candidates = generationFirst ? plan.deletedGenerations : plan.deletedBlocks;
  const artifact = generationFirst ? 'generation' : 'store-block';
  if (candidates.length === 0) return plan;
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      journalBytesForDeleteBatch(
        dshHome,
        txid,
        candidates.slice(0, middle).map((file) => ({ file, artifact })),
      ) <= maximumBytes
    )
      low = middle;
    else high = middle - 1;
  }
  if (low === 0) {
    fail(
      EXIT_CODES.CONTRACT,
      'E_GC_JOURNAL_LIMIT',
      'one GC state deletion cannot fit in the bounded transaction journal.',
    );
  }
  return generationFirst
    ? { deletedGenerations: candidates.slice(0, low) as GenerationManifest[], deletedBlocks: [] }
    : { deletedGenerations: [], deletedBlocks: candidates.slice(0, low) };
}

function lockedScanFailure(error: unknown): never {
  if (error instanceof GcFailure) {
    throw new TransactionFailure(error.exitCode, [
      diagnostic(
        error.code,
        'error',
        error.message,
        'Repair the generation store and retry; no collection plan was applied.',
      ),
    ]);
  }
  throw error;
}

export async function runGc(input: GcInput, dependencies: GcDependencies = {}): Promise<GcReport> {
  const resolution = resolveDshHomeValue(input.dshHome);
  if (!resolution.ok) {
    return {
      diagnostics: resolution.report.diagnostics,
      exitCode: resolution.report.exitCode,
      metadata: {
        dryRun: input.dryRun,
        keep: input.keep ?? DEFAULT_KEEP,
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: [],
      },
    };
  }
  const normalized = { ...input, dshHome: resolution.value };
  let keep: number;
  let initial: GcPlan;
  const adapter = dependencies.createAdapter?.() ?? createNodeTransactionAdapter();
  const bindRoot = dependencies.bindRoot ?? bindSecureRoot;
  try {
    keep = assertKeep(input.keep);
    initial = await scanPlan(normalized.dshHome, keep, dependencies.safePathHooks, false, bindRoot);
    // Validate prior committed cleanup before any active state can be changed, but do not purge
    // it until the active generation plan is known valid.
    await scanGcQuarantine(normalized.dshHome, bindRoot);
  } catch (error) {
    return failureReport(normalized, error);
  }
  if (normalized.dryRun)
    return {
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: metadata(normalized, initial),
    };
  if (initial.deletedGenerations.length === 0 && initial.deletedBlocks.length === 0) {
    try {
      await purgeCommittedStateQuarantine(normalized.dshHome, adapter, undefined, bindRoot);
    } catch (error) {
      return error instanceof GcFailure && error.physicalProgress
        ? pendingPurgeReport(normalized, initial, error)
        : failureReport(normalized, error);
    }
    return {
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: metadata(normalized, initial),
    };
  }
  const txid = dependencies.createTxid?.() ?? `gc-${randomUUID()}`;
  if (!isGcTransactionId(txid)) {
    return failureReport(
      normalized,
      new GcFailure(
        EXIT_CODES.CONTRACT,
        'E_GC_TXID',
        'GC transaction identifiers must use the gc-* namespace.',
      ),
    );
  }
  const maximumJournalBytes = dependencies.maxJournalBytes ?? MAX_TRANSACTION_STATE_BYTES;
  if (
    !Number.isSafeInteger(maximumJournalBytes) ||
    maximumJournalBytes < 1 ||
    maximumJournalBytes > MAX_TRANSACTION_STATE_BYTES
  ) {
    return failureReport(
      normalized,
      new GcFailure(
        EXIT_CODES.CONTRACT,
        'E_GC_JOURNAL_LIMIT',
        'GC journal limit must be a positive safe integer.',
      ),
    );
  }
  let selected: GcPlan;
  try {
    selected = selectGcBatch(normalized.dshHome, txid, initial, maximumJournalBytes);
  } catch (error) {
    return failureReport(normalized, error);
  }
  const transaction = await runTransaction(
    {
      adapter,
      dshHome: normalized.dshHome,
      txid,
      purpose: 'gc',
    },
    async (context) => {
      await dependencies.onBeforeLockedScan?.();
      let locked: GcPlan;
      try {
        locked = await scanPlan(
          normalized.dshHome,
          keep,
          dependencies.safePathHooks,
          true,
          bindRoot,
        );
      } catch (error) {
        lockedScanFailure(error);
      }
      if (!samePlan(initial, locked)) {
        throw new TransactionFailure(EXIT_CODES.CONTRACT, [
          diagnostic(
            'E_GC_STATE_CHANGED',
            'error',
            'generation state changed after GC planning.',
            'Run GC again to build a fresh plan; no state file was collected.',
          ),
        ]);
      }
      let lockedBatch: GcPlan;
      try {
        lockedBatch = selectGcBatch(normalized.dshHome, txid, locked, maximumJournalBytes);
      } catch (error) {
        lockedScanFailure(error);
      }
      if (!samePlan(selected, lockedBatch)) {
        throw new TransactionFailure(EXIT_CODES.CONTRACT, [
          diagnostic(
            'E_GC_STATE_CHANGED',
            'error',
            'generation collection batch changed after GC planning.',
            'Run GC again to build a fresh plan; no state file was collected.',
          ),
        ]);
      }
      for (const generation of lockedBatch.deletedGenerations) {
        await context.deleteStateFile(
          'generation',
          generation.path,
          generation.sha256,
          generation.identity,
        );
      }
      for (const block of lockedBatch.deletedBlocks) {
        await context.deleteStateFile('store-block', block.path, block.sha256, block.identity);
      }
      return lockedBatch;
    },
  );
  if (!transaction.ok) {
    return {
      diagnostics: transaction.diagnostics,
      exitCode: transaction.exitCode,
      metadata: {
        dryRun: false,
        keep,
        deletedGenerations: [],
        deletedBlocks: [],
        pendingPurge: false,
        manualRecovery: transaction.manualRecovery,
      },
    };
  }
  try {
    await purgeCommittedStateQuarantine(normalized.dshHome, adapter, undefined, bindRoot);
  } catch (error) {
    return pendingPurgeReport(normalized, transaction.value as GcPlan, error);
  }
  return {
    diagnostics: [],
    exitCode: EXIT_CODES.SUCCESS,
    metadata: metadata(normalized, transaction.value as GcPlan),
  };
}
