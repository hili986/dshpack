import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  type Diagnostic,
  type PackLock,
  type PackLockedPlugin,
  type PackManifest,
  type PluginDeclaration,
  parseLock,
  parsePack,
  resolveIntegrityFromPnpmLock,
} from '@dshpack/core';
import { stringify } from 'yaml';

import { writeFileAtomic } from '../adapters/fs.js';
import { runDsh } from '../adapters/process.js';
import { type CommandReport, diagnostic, exitCodeFor } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import { verifyInstalledPlugin } from '../install/profile-plugin.js';
import type { InstallResolvedPlugin } from '../install/types.js';
import {
  isIgnoredPackPath,
  isSemanticPackPath,
  validateLocalPack,
} from '../validation/validate-pack.js';
import { GENERATED_BY } from '../version.js';

const LOCK_PROFILE = 'dshpack-lock';
const DETERMINISTIC_GENERATED_AT = '1970-01-01T00:00:00Z';

export interface LockMetadata {
  source: string;
  written: boolean;
}

export interface LockOptions {
  /** Test-only dependency injection. Production always owns an in-pack temporary DSH_HOME. */
  dshHome?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
}

export interface LockReport extends CommandReport<LockMetadata> {
  lockText?: string;
}

interface SemanticFile {
  bytes: Uint8Array;
  path: string;
}

function sha256(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
}

function sha512(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function withinRoot(root: string, candidate: string): boolean {
  const contained = relative(root, candidate);
  return (
    contained !== '' &&
    !contained.startsWith(`..${sep}`) &&
    contained !== '..' &&
    !isAbsolute(contained)
  );
}

function report(
  source: string,
  diagnostics: readonly Diagnostic[],
  exitCode = exitCodeFor(diagnostics),
): LockReport {
  return { diagnostics, exitCode, metadata: { source, written: false } };
}

function sourceSpec(plugin: PluginDeclaration): string {
  if (plugin.source.kind === 'npm') return `${plugin.name}@${plugin.source.range}`;
  if (plugin.source.kind === 'github')
    return `github:${plugin.source.owner}/${plugin.source.repo}#${plugin.source.ref}`;
  return plugin.source.url;
}

function retainedGeneratedAt(existingLock: string | undefined): string {
  if (existingLock === undefined) return DETERMINISTIC_GENERATED_AT;
  const parsed = parseLock(existingLock);
  return parsed.value?.generatedAt ?? DETERMINISTIC_GENERATED_AT;
}

function posixRelative(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join('/');
}

async function collectSemanticFiles(root: string): Promise<SemanticFile[]> {
  const files: SemanticFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const names = await readdir(directory, { encoding: 'utf8' });
    for (const name of names.sort((left, right) => left.localeCompare(right))) {
      const absolute = join(directory, name);
      const path = posixRelative(root, absolute);
      if (isIgnoredPackPath(path)) continue;
      const stat = await lstat(absolute);
      if (stat.isDirectory()) await visit(absolute);
      if (stat.isFile() && isSemanticPackPath(path)) {
        files.push({ path, bytes: await readFile(absolute) });
      }
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function packageFactsDiagnostic(plugin: PluginDeclaration): Diagnostic {
  return diagnostic(
    'E_LOCK_PACKAGE_FACTS',
    'error',
    '无法读取实际安装插件的 package.json 与 dsh.bundle.patch 事实。',
    '确认该插件可由 dsh 安装，且安装包声明可读取的 dsh.bundle.patch。',
    plugin.name,
  );
}

async function resolveInstalledPlugins(
  root: string,
  manifest: PackManifest,
  options: LockOptions,
): Promise<{ diagnostics: Diagnostic[]; plugins: PackLockedPlugin[] }> {
  if (manifest.plugins.length === 0) return { diagnostics: [], plugins: [] };

  const dshHome = options.dshHome === undefined ? undefined : resolve(options.dshHome);
  if (dshHome !== undefined && !withinRoot(root, dshHome)) {
    return {
      diagnostics: [
        diagnostic(
          'E_LOCK_TEMP_HOME',
          'error',
          'lock 的临时 DSH_HOME 必须位于目标 pack 目录内。',
          '移除覆盖参数，让 lock 自行创建隔离临时目录。',
        ),
      ],
      plugins: [],
    };
  }

  const temporaryRoot =
    dshHome === undefined ? await mkdtemp(join(root, '.dshpack-lock-')) : undefined;
  const isolatedHome = dshHome ?? join(temporaryRoot as string, 'home');
  const profileRoot = join(isolatedHome, 'profiles', LOCK_PROFILE);
  const diagnostics: Diagnostic[] = [];
  const plugins: PackLockedPlugin[] = [];

  try {
    try {
      await runDsh(['plugin', '--profile', LOCK_PROFILE, 'list', '--depth=0'], {
        cwd: temporaryRoot ?? root,
        dshHome: isolatedHome,
        timeout: 30_000,
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch {
      diagnostics.push(
        diagnostic(
          'E_LOCK_DSH',
          'error',
          '无法初始化用于生成 lock 的隔离 dsh profile。',
          '确认 PATH 上可运行 dsh，或检查网络后重试。',
        ),
      );
      return { diagnostics, plugins: [] };
    }

    for (const plugin of manifest.plugins) {
      try {
        await runDsh(['plugin', '--profile', LOCK_PROFILE, 'add', sourceSpec(plugin)], {
          cwd: temporaryRoot ?? root,
          dshHome: isolatedHome,
          timeout: 30_000,
          ...(options.env === undefined ? {} : { env: options.env }),
        });
      } catch {
        diagnostics.push(
          diagnostic(
            'E_LOCK_DSH',
            'error',
            'dsh 未能安装用于 lock 的插件。',
            '确认 manifest 插件来源可访问且 dsh 支持该来源。',
            plugin.name,
          ),
        );
        continue;
      }

      const lockSource = await readOptional(join(profileRoot, 'pnpm-lock.yaml'));
      const resolved = resolveIntegrityFromPnpmLock(lockSource, plugin);
      if (resolved.value === undefined) {
        diagnostics.push(...resolved.diagnostics);
        continue;
      }

      const expected: InstallResolvedPlugin = {
        name: plugin.name,
        resolved: resolved.value.resolved,
        integrity: resolved.value.integrity,
      };
      try {
        const facts = await verifyInstalledPlugin(profileRoot, plugin, expected);
        plugins.push({
          name: plugin.name,
          resolved: facts.actualResolved,
          integrity: facts.actualIntegrity,
          packageJsonSha512: facts.packageJsonSha512,
          bundlePatch: facts.bundlePatch,
        });
      } catch {
        diagnostics.push(packageFactsDiagnostic(plugin));
      }
    }
    return { diagnostics, plugins };
  } finally {
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Generate a schema-valid handwritten-pack lock without writing pack.lock.yml. */
export async function generateLock(source: string, options: LockOptions = {}): Promise<LockReport> {
  const root = resolve(source);
  const validated = await validateLocalPack(root, { strict: true, lockPolicy: 'ignored' });
  if (validated.exitCode !== EXIT_CODES.SUCCESS)
    return report(root, validated.diagnostics, validated.exitCode);

  let files: SemanticFile[];
  try {
    files = await collectSemanticFiles(root);
  } catch {
    return report(root, [
      diagnostic(
        'E_LOCK_READ',
        'error',
        '无法读取 pack 的语义文件以生成 lock。',
        '检查目录权限与普通文件状态后重试。',
      ),
    ]);
  }
  const pack = files.find(({ path }) => path === 'pack.yml');
  if (pack === undefined)
    return report(root, [
      diagnostic(
        'E_LOCK_MANIFEST',
        'error',
        'pack.yml 不可读取。',
        '修复 pack.yml 后重试。',
        'pack.yml',
      ),
    ]);
  const parsed = parsePack(Buffer.from(pack.bytes).toString('utf8'));
  if (parsed.value === undefined) return report(root, parsed.diagnostics);

  const installed = await resolveInstalledPlugins(root, parsed.value, options);
  if (installed.diagnostics.length > 0) {
    const dshFailure = installed.diagnostics.some(({ code }) => code === 'E_LOCK_DSH');
    return report(
      root,
      installed.diagnostics,
      dshFailure ? EXIT_CODES.DSH_SUBPROCESS_FAILURE : exitCodeFor(installed.diagnostics),
    );
  }

  const existingLock = await readOptional(join(root, 'pack.lock.yml'));
  const payload = files
    .filter(({ path }) => path !== 'pack.yml' && path !== 'pack.lock.yml')
    .map(({ path, bytes }) => ({ path, sha512: sha512(bytes) }));
  const lock: PackLock = {
    lockVersion: 0,
    manifestSha256: sha256(pack.bytes),
    generatedBy: GENERATED_BY,
    generatedAt: retainedGeneratedAt(existingLock),
    dsh: { exportedFrom: parsed.value.dsh.tested[0] as string },
    plugins: installed.plugins,
    files: payload,
  };
  return {
    diagnostics: [],
    exitCode: EXIT_CODES.SUCCESS,
    metadata: { source: root, written: false },
    lockText: stringify(lock, { lineWidth: 0 }),
  };
}

/** Atomically publish a generated lock only as <source>/pack.lock.yml. */
export async function generateAndWriteLock(
  source: string,
  options: LockOptions = {},
): Promise<LockReport> {
  const root = resolve(source);
  const generated = await generateLock(root, options);
  if (generated.lockText === undefined || generated.exitCode !== EXIT_CODES.SUCCESS)
    return generated;

  const target = resolve(root, 'pack.lock.yml');
  if (relative(root, target) !== 'pack.lock.yml') {
    return report(root, [
      diagnostic(
        'E_LOCK_TARGET',
        'error',
        '拒绝写入 pack 目录以外的 lock 目标。',
        '使用普通本地 pack 目录。',
      ),
    ]);
  }
  try {
    await writeFileAtomic(target, generated.lockText, { mode: 0o600 });
  } catch {
    return report(root, [
      diagnostic(
        'E_LOCK_WRITE',
        'error',
        '无法原子写入 pack.lock.yml。',
        '检查 pack 目录权限后重试。',
        'pack.lock.yml',
      ),
    ]);
  }
  return { ...generated, metadata: { source: root, written: true } };
}
