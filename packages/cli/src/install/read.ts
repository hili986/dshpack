import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  type Diagnostic,
  type PackLock,
  type PackManifest,
  parseLock,
  parsePack,
} from '@dshpack/core';

import { validateLocalPack } from '../validation/validate-pack.js';
import {
  captureSourceDirectory,
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_FILES,
  MAX_SOURCE_TOTAL_BYTES,
  SnapshotCaptureError,
} from './snapshot-capture.js';
import { assertPortableSnapshotEntries } from './snapshot-path.js';

export interface ValidatedPackFile {
  path: string;
  sha512: string;
  /** Immutable transport form; consumers decode a fresh Buffer and never re-read SOURCE. */
  contentBase64: string;
}

export interface ValidatedPackMaterial {
  manifest: PackManifest;
  lock: PackLock;
  paths: readonly string[];
  files: readonly ValidatedPackFile[];
  sourceFiles: readonly { path: string; sha512: string }[];
  lockDigest: string;
}

export interface ReadPackResult {
  material?: ValidatedPackMaterial;
  diagnostics: readonly Diagnostic[];
  exitCode: 20 | 30 | 31;
}

export interface ReadPackDependencies {
  accessFile?: typeof access;
  validate?: typeof validateLocalPack;
  readText?: (path: string) => Promise<string>;
  readBytes?: (path: string) => Promise<Uint8Array>;
  listPaths?: (root: string) => Promise<string[]>;
  makeTempDirectory?: () => Promise<string>;
  removeTempDirectory?: (path: string) => Promise<void>;
}

const error = (code: string, message: string, hint: string, path?: string): Diagnostic => ({
  code,
  severity: 'error',
  message,
  hint,
  evidence: 'local',
  ...(path === undefined ? {} : { path }),
});

const sha512 = (bytes: Uint8Array): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const sha256 = (bytes: Uint8Array): string =>
  `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
export function validationExitCode(diagnostics: readonly Diagnostic[]): 20 | 30 | 31 {
  if (
    diagnostics.some(({ code }) =>
      /^(?:E_PATH|E_SECRET|E_SETTINGS_MCP_ENV|E_MCP_CREDENTIAL)/u.test(code),
    )
  ) {
    return 31;
  }
  if (diagnostics.some(({ code }) => /^(?:E_SOURCE|E_LOCK)/u.test(code))) return 20;
  return 30;
}

async function capture(
  root: string,
  paths: readonly string[],
  dependencies: ReadPackDependencies,
): Promise<ValidatedPackFile[]> {
  const readText = dependencies.readText;
  const read =
    dependencies.readBytes ??
    (readText === undefined
      ? async () => {
          throw new Error('injected listPaths requires readText or readBytes');
        }
      : async (path: string): Promise<Uint8Array> => Buffer.from(await readText(path), 'utf8'));
  const filePaths = paths.filter((path) => !path.endsWith('/'));
  if (filePaths.length > MAX_SOURCE_FILES)
    throw new SnapshotCaptureError('limit', 'source has too many files');
  const files: ValidatedPackFile[] = [];
  let total = 0;
  for (const path of filePaths) {
    const bytes = await read(join(root, path));
    if (bytes.byteLength > MAX_SOURCE_FILE_BYTES)
      throw new SnapshotCaptureError('limit', `source file too large: ${path}`);
    total += bytes.byteLength;
    if (total > MAX_SOURCE_TOTAL_BYTES)
      throw new SnapshotCaptureError('limit', 'source total is too large');
    files.push({
      path,
      sha512: sha512(bytes),
      contentBase64: Buffer.from(bytes).toString('base64'),
    });
  }
  return files;
}

async function writeSnapshot(
  workspace: string,
  paths: readonly string[],
  files: readonly ValidatedPackFile[],
): Promise<string> {
  assertPortableSnapshotEntries(
    paths.map((entry) => ({
      path: entry.endsWith('/') ? entry.slice(0, -1) : entry,
      kind: entry.endsWith('/') ? ('directory' as const) : ('file' as const),
    })),
  );
  const snapshot = join(workspace, 'pack');
  await mkdir(snapshot, { mode: 0o700 });
  for (const entry of paths) {
    const path = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    const destination = join(snapshot, ...path.split('/'));
    if (entry.endsWith('/')) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      continue;
    }
    const file = files.find((candidate) => candidate.path === entry) as ValidatedPackFile;
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, Buffer.from(file.contentBase64, 'base64'), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return snapshot;
}

function sameCapture(
  left: readonly ValidatedPackFile[],
  right: readonly ValidatedPackFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.path === right[index]?.path && file.contentBase64 === right[index]?.contentBase64,
    )
  );
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function fileBytes(files: readonly ValidatedPackFile[], path: string): Buffer | undefined {
  const encoded = files.find((file) => file.path === path)?.contentBase64;
  return encoded === undefined ? undefined : Buffer.from(encoded, 'base64');
}

function encodeCapturedFiles(
  files: readonly { path: string; bytes: Uint8Array }[],
): ValidatedPackFile[] {
  return files.map(({ path, bytes }) => ({
    path,
    sha512: sha512(bytes),
    contentBase64: Buffer.from(bytes).toString('base64'),
  }));
}

export async function readValidatedPack(
  directory: string,
  dependencies: ReadPackDependencies = {},
): Promise<ReadPackResult> {
  const accessFile = dependencies.accessFile ?? access;
  const validate = dependencies.validate ?? validateLocalPack;
  try {
    await accessFile(join(directory, 'pack.lock.yml'));
  } catch {
    return {
      diagnostics: [
        error(
          'E_NO_LOCK',
          '缺少 pack.lock.yml；install 默认冻结 lock。',
          '提供完整 pack.lock.yml。',
        ),
      ],
      exitCode: 20,
    };
  }
  let workspace: string | undefined;
  let result: ReadPackResult;
  try {
    let sourcePaths: string[];
    let sourceFiles: ValidatedPackFile[];
    if (dependencies.listPaths === undefined) {
      const captured = await captureSourceDirectory(directory);
      sourcePaths = captured.entries.map(({ path, kind }) =>
        kind === 'directory' ? `${path}/` : path,
      );
      sourceFiles = encodeCapturedFiles(captured.files);
    } else {
      sourcePaths = [...(await dependencies.listPaths(directory))].sort((left, right) =>
        left.localeCompare(right, 'en'),
      );
      sourceFiles = await capture(directory, sourcePaths, dependencies);
    }
    workspace = await (
      dependencies.makeTempDirectory ?? (async () => mkdtemp(join(tmpdir(), 'dshpack-plan-')))
    )();
    await chmod(workspace, 0o700);
    const snapshot = await writeSnapshot(workspace, sourcePaths, sourceFiles);
    const validation = await validate(snapshot);
    const failures = validation.diagnostics.filter(({ severity }) => severity === 'error');
    if (failures.length > 0) {
      result = { diagnostics: validation.diagnostics, exitCode: validationExitCode(failures) };
    } else {
      const validated = await captureSourceDirectory(snapshot);
      const validatedFiles = encodeCapturedFiles(validated.files);
      const validatedPaths = validated.entries.map(({ path, kind }) =>
        kind === 'directory' ? `${path}/` : path,
      );
      if (!samePaths(sourcePaths, validatedPaths) || !sameCapture(sourceFiles, validatedFiles)) {
        result = {
          diagnostics: [
            error(
              'E_SOURCE_SNAPSHOT_CHANGED',
              '私有验证快照在验证期间发生变化。',
              '停止安装并检查 validator 或本机临时目录安全。',
              snapshot,
            ),
          ],
          exitCode: 20,
        };
      } else {
        const manifestBytes = fileBytes(sourceFiles, 'pack.yml');
        const lockBytes = fileBytes(sourceFiles, 'pack.lock.yml');
        if (manifestBytes === undefined || lockBytes === undefined)
          throw new Error('missing documents');
        const manifest = parsePack(manifestBytes.toString('utf8'));
        const lock = parseLock(lockBytes.toString('utf8'));
        if (manifest.value === undefined || lock.value === undefined) {
          const diagnostics = [...manifest.diagnostics, ...lock.diagnostics];
          result = { diagnostics, exitCode: validationExitCode(diagnostics) };
        } else {
          const frozenFiles = Object.freeze(sourceFiles.map((file) => Object.freeze({ ...file })));
          const filePaths = frozenFiles.map(({ path }) => path);
          result = {
            material: {
              manifest: manifest.value,
              lock: lock.value,
              paths: Object.freeze(filePaths),
              files: frozenFiles,
              sourceFiles: Object.freeze(
                frozenFiles.map(({ path, sha512: digest }) =>
                  Object.freeze({ path, sha512: digest }),
                ),
              ),
              lockDigest: sha256(lockBytes),
            },
            diagnostics: validation.diagnostics,
            exitCode: 30,
          };
        }
      }
    }
  } catch (caught) {
    result = {
      diagnostics: [
        error(
          caught instanceof SnapshotCaptureError && caught.kind === 'security'
            ? 'E_SOURCE_SNAPSHOT_ENTRY'
            : caught instanceof SnapshotCaptureError && caught.kind === 'limit'
              ? 'E_SOURCE_SNAPSHOT_LIMIT'
              : 'E_SOURCE_READ',
          caught instanceof SnapshotCaptureError && caught.kind === 'security'
            ? 'SOURCE 含不能安全快照的文件系统条目。'
            : caught instanceof SnapshotCaptureError && caught.kind === 'limit'
              ? 'SOURCE 超过 1000 文件、单文件 1 MiB 或总量 10 MiB 限制。'
              : '无法获取与验证绑定的 SOURCE 字节。',
          caught instanceof SnapshotCaptureError && caught.kind === 'security'
            ? '移除 symlink、设备文件与不安全路径。'
            : caught instanceof SnapshotCaptureError && caught.kind === 'limit'
              ? '缩小 pack 后重试；不得绕过 SOURCE 上限。'
              : '固定 SOURCE 后重试，避免并发修改。',
          directory,
        ),
      ],
      exitCode: caught instanceof SnapshotCaptureError && caught.kind === 'security' ? 31 : 20,
    };
  }
  if (workspace !== undefined) {
    try {
      await (
        dependencies.removeTempDirectory ??
        ((path: string) => rm(path, { recursive: true, force: true }))
      )(workspace);
    } catch {
      return {
        diagnostics: [
          error(
            'E_SOURCE_SNAPSHOT_CLEANUP',
            '私有 SOURCE 验证快照清理失败。',
            `人工检查并移除临时目录：${workspace}`,
            workspace,
          ),
        ],
        exitCode: 20,
      };
    }
  }
  return result;
}
