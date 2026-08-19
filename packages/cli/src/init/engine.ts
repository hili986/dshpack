import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { PackManifest } from '@dshpack/core';
import { stringify } from 'yaml';

import { type CommandReport, diagnostic } from '../commands/shared.js';
import { EXIT_CODES } from '../exit-codes.js';
import { generateAndWriteLock, type LockOptions, type LockReport } from '../lock/engine.js';
import {
  type ValidateMetadata,
  type ValidateOptions,
  validateLocalPack,
} from '../validation/validate-pack.js';

export type InitTemplate = 'minimal' | 'skills' | 'mcp' | 'full';

export interface InitInput {
  author: string;
  description: string;
  directory: string;
  license: string;
  name: string;
  template: InitTemplate;
  version: string;
}

export interface InitMetadata {
  directory: string;
  files?: readonly string[];
  template: InitTemplate;
}

export type InitReport = CommandReport<InitMetadata>;

export interface InitDependencies {
  generateLock?: (source: string, options?: LockOptions) => Promise<LockReport>;
  validate?: (
    source: string,
    options?: ValidateOptions,
  ) => Promise<CommandReport<ValidateMetadata>>;
}

interface Material {
  path: string;
  text: string;
}

function failure(input: InitInput, code: string, message: string, hint: string): InitReport {
  return {
    diagnostics: [diagnostic(code, 'error', message, hint)],
    exitCode: EXIT_CODES.CONTRACT,
    metadata: { directory: resolve(input.directory), template: input.template },
  };
}

function manifest(input: InitInput): PackManifest {
  return {
    formatVersion: 0,
    name: input.name,
    version: input.version,
    description: input.description,
    author: input.author,
    license: input.license,
    dsh: { tested: ['0.1.0-rc.6'] },
    plugins: [],
    mcp:
      input.template === 'mcp' || input.template === 'full'
        ? [
            {
              serverName: 'example-mcp',
              transport: 'streamable-http',
              url: 'https://example.invalid/mcp',
              description: 'Replace this placeholder with your MCP endpoint.',
            },
          ]
        : [],
    defaults: { permissionPreset: 'workspace-write' },
    ...(input.template === 'full'
      ? { settings: { namespaces: { 'agent-presets': 'agent-presets.yml' } } }
      : {}),
  };
}

function materials(input: InitInput): Material[] {
  const output: Material[] = [
    { path: 'pack.yml', text: stringify(manifest(input), { lineWidth: 0 }) },
    { path: 'patch/cordis.patch.yml', text: '[]\n' },
    {
      path: 'README.md',
      text: `# ${input.name}\n\n${input.description}\n`,
    },
    {
      path: '.gitignore',
      text: '.DS_Store\nnode_modules/\n',
    },
  ];
  if (input.template === 'skills' || input.template === 'full') {
    output.push({
      path: 'skills/example-skill/SKILL.md',
      text: '---\nname: example-skill\ndescription: A harmless example skill.\n---\n\n# Example skill\n\nWrite a concise helpful response.\n',
    });
  }
  if (input.template === 'full') {
    output.push(
      {
        path: 'settings/agent-presets.yml',
        text: 'example:\n  permissionPreset: workspace-write\n',
      },
      { path: 'presets/example/agent.cordis.yml', text: '[]\n' },
    );
  }
  return output;
}

async function targetIsAvailable(target: string): Promise<boolean> {
  try {
    const state = await lstat(target);
    if (!state.isDirectory() || state.isSymbolicLink()) return false;
    return (await readdir(target)).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function writeMaterials(root: string, entries: readonly Material[]): Promise<void> {
  for (const entry of entries) {
    const target = join(root, ...entry.path.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, entry.text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
}

function temporaryDirectory(target: string): string {
  return join(
    dirname(target),
    `.${basename(target)}.dshpack-init-${randomBytes(8).toString('hex')}`,
  );
}

/** Build every file in a private sibling then publish once lock and strict validation succeed. */
export async function initializePack(
  input: InitInput,
  dependencies: InitDependencies = {},
): Promise<InitReport> {
  const target = resolve(input.directory);
  if (!(await targetIsAvailable(target))) {
    return failure(
      input,
      'E_INIT_DIRECTORY',
      '目标目录必须不存在或为空的普通目录。',
      '选择一个新目录，或显式清空目标目录后重试。',
    );
  }
  const staging = temporaryDirectory(target);
  const generateLock = dependencies.generateLock ?? generateAndWriteLock;
  const validate = dependencies.validate ?? validateLocalPack;
  const files = materials(input);
  try {
    await mkdir(staging, { mode: 0o700 });
    await writeMaterials(staging, files);
    const locked = await generateLock(staging);
    if (locked.exitCode !== EXIT_CODES.SUCCESS) {
      return {
        diagnostics: locked.diagnostics,
        exitCode: locked.exitCode,
        metadata: { directory: target, template: input.template },
      };
    }
    const validated = await validate(staging, { strict: true });
    if (validated.exitCode !== EXIT_CODES.SUCCESS) {
      return {
        diagnostics: validated.diagnostics,
        exitCode: validated.exitCode,
        metadata: { directory: target, template: input.template },
      };
    }
    try {
      await rename(staging, target);
    } catch {
      return failure(
        input,
        'E_INIT_PUBLISH',
        '无法原子发布初始化的 pack。',
        '检查目标父目录权限后重试。',
      );
    }
    return {
      diagnostics: [],
      exitCode: EXIT_CODES.SUCCESS,
      metadata: {
        directory: target,
        files: [...files.map(({ path }) => path), 'pack.lock.yml'],
        template: input.template,
      },
    };
  } catch {
    return failure(input, 'E_INIT_WRITE', '无法写入初始化模板。', '检查目标父目录权限后重试。');
  } finally {
    // Staging is never user-visible output. Removing it cannot touch the pre-existing target tree.
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
