import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import {
  type Diagnostic,
  type PackLock,
  type PackManifest,
  parseLock,
  parsePack,
} from '@dshpack/core';

import { validateLocalPack } from '../validation/validate-pack.js';

export interface ValidatedPackMaterial {
  manifest: PackManifest;
  lock: PackLock;
  paths: readonly string[];
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
  listPaths?: (root: string) => Promise<string[]>;
}

const error = (code: string, message: string, hint: string, path?: string): Diagnostic => ({
  code,
  severity: 'error',
  message,
  hint,
  evidence: 'local',
  ...(path === undefined ? {} : { path }),
});

export function validationExitCode(diagnostics: readonly Diagnostic[]): 20 | 30 | 31 {
  if (diagnostics.some(({ code }) => /^(?:E_PATH|E_SECRET|E_SETTINGS_MCP_ENV)/u.test(code))) {
    return 31;
  }
  if (diagnostics.some(({ code }) => /^(?:E_SOURCE|E_LOCK)/u.test(code))) return 20;
  return 30;
}

async function allPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      paths.push(path);
      if (entry.isDirectory()) await visit(absolute);
    }
  };
  await visit(root);
  return paths.sort((left, right) => left.localeCompare(right, 'en'));
}

export async function readValidatedPack(
  directory: string,
  dependencies: ReadPackDependencies = {},
): Promise<ReadPackResult> {
  const accessFile = dependencies.accessFile ?? access;
  const validate = dependencies.validate ?? validateLocalPack;
  const readText = dependencies.readText ?? ((path: string) => readFile(path, 'utf8'));
  const listPaths = dependencies.listPaths ?? allPaths;
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
  const validation = await validate(directory);
  const failures = validation.diagnostics.filter(({ severity }) => severity === 'error');
  if (failures.length > 0) {
    return { diagnostics: validation.diagnostics, exitCode: validationExitCode(failures) };
  }
  try {
    const [manifestText, lockText, paths] = await Promise.all([
      readText(join(directory, 'pack.yml')),
      readText(join(directory, 'pack.lock.yml')),
      listPaths(directory),
    ]);
    const manifest = parsePack(manifestText);
    const lock = parseLock(lockText);
    if (manifest.value === undefined || lock.value === undefined) {
      const diagnostics = [...manifest.diagnostics, ...lock.diagnostics];
      return { diagnostics, exitCode: validationExitCode(diagnostics) };
    }
    return {
      material: { manifest: manifest.value, lock: lock.value, paths },
      diagnostics: validation.diagnostics,
      exitCode: 30,
    };
  } catch {
    return {
      diagnostics: [
        error(
          'E_SOURCE_READ',
          '验证后无法重读 source；source 状态可能已变化。',
          '固定 source 后重试，避免并发修改。',
          directory,
        ),
      ],
      exitCode: 20,
    };
  }
}
