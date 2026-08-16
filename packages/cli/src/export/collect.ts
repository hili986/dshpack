import { join } from 'node:path';

import {
  type Diagnostic,
  type PackLockedPlugin,
  type PluginDeclaration,
  parseCanonicalYaml,
  redactSecrets,
  resolveIntegrityFromPnpmLock,
  scanSecrets,
} from '@dshpack/core';
import { stringify } from 'yaml';

import { diagnostic } from '../commands/shared.js';
import { text } from '../doctor/support.js';
import { collectDirectory, type Material, sha512, sourceFromSpecifier } from './support.js';
import type { ExportInput } from './types.js';

export function packDiagnostic(code: string, message: string, path?: string): Diagnostic {
  return diagnostic(code, 'error', message, '修正 profile 后重试。', path);
}

export function testedVersion(value: string): string | undefined {
  const version = value.replace(/\n$/u, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version) ? version : undefined;
}

function unverifiedPlugin(
  declaration: PluginDeclaration,
  reason: string,
  packageJsonSha512: string,
  bundlePatch: string,
): PackLockedPlugin {
  const resolved =
    declaration.source.kind === 'github'
      ? { commit: declaration.source.ref }
      : declaration.source.kind === 'tarball'
        ? { url: declaration.source.url }
        : { version: declaration.source.range.replace(/^[~^]/u, '') || '0.0.0' };
  return {
    name: declaration.name,
    resolved,
    integrity: { kind: 'unverified', reason },
    packageJsonSha512,
    bundlePatch,
  };
}

export async function buildPluginFacts(
  root: string,
  dependencies: Readonly<Record<string, string>>,
  bundles: readonly string[],
  lockSource: string | undefined,
  allowUnverified: boolean,
): Promise<{
  diagnostics: Diagnostic[];
  plugins: PluginDeclaration[];
  locked: PackLockedPlugin[];
  unverified: boolean;
}> {
  const diagnostics: Diagnostic[] = [];
  const plugins: PluginDeclaration[] = [];
  const locked: PackLockedPlugin[] = [];
  let unverified = false;
  for (const name of bundles) {
    if (name === '@deepseek-ai/dsh-base') continue;
    const specifier = dependencies[name];
    if (specifier === undefined) {
      diagnostics.push(
        packDiagnostic(
          'E_EXPORT_BUNDLE_DEPENDENCY',
          '激活 bundle 未出现在 profile dependencies。',
          name,
        ),
      );
      continue;
    }
    const source = sourceFromSpecifier(name, specifier);
    diagnostics.push(...source.diagnostics);
    if (source.source === undefined) continue;
    const packageFile = join(root, 'node_modules', ...name.split('/'), 'package.json');
    const packageText = await text(packageFile);
    if (packageText === undefined) {
      diagnostics.push(
        packDiagnostic(
          'E_EXPORT_BUNDLE_PACKAGE',
          '无法读取实际安装 bundle 的 package.json。',
          packageFile,
        ),
      );
      continue;
    }
    let bundlePatch: string | undefined;
    try {
      const packageJson = JSON.parse(packageText) as { dsh?: { bundle?: { patch?: unknown } } };
      const value = packageJson.dsh?.bundle?.patch;
      if (typeof value === 'string' && value.length > 0) bundlePatch = value;
    } catch {
      diagnostics.push(
        packDiagnostic('E_EXPORT_BUNDLE_PACKAGE', 'bundle package.json 无法解析。', packageFile),
      );
      continue;
    }
    if (bundlePatch === undefined) {
      diagnostics.push(
        packDiagnostic(
          'E_EXPORT_BUNDLE_PATCH',
          '已激活 dependency 未声明 dsh.bundle.patch。',
          packageFile,
        ),
      );
      continue;
    }
    const declaration: PluginDeclaration = { name, source: source.source, allowBuilds: false };
    plugins.push(declaration);
    const packageJsonSha512 = sha512(Buffer.from(packageText));
    const resolved = resolveIntegrityFromPnpmLock(lockSource, declaration);
    if (resolved.value !== undefined)
      locked.push({ ...resolved.value, packageJsonSha512, bundlePatch });
    else if (allowUnverified) {
      unverified = true;
      locked.push(
        unverifiedPlugin(
          declaration,
          resolved.diagnostics[0]?.code ?? 'lock unavailable',
          packageJsonSha512,
          bundlePatch,
        ),
      );
    } else diagnostics.push(...resolved.diagnostics);
  }
  return { diagnostics, plugins, locked, unverified };
}

export async function collectOptionalAssets(
  input: ExportInput,
): Promise<{ diagnostics: Diagnostic[]; materials: Material[]; redactions: string[] }> {
  const diagnostics: Diagnostic[] = [];
  const materials: Material[] = [];
  const redactions: string[] = [];
  if (input.includeSkills) {
    const skills = await collectDirectory(join(input.dshHome, 'skills'), 'skills');
    diagnostics.push(...skills.diagnostics);
    materials.push(...skills.materials);
  }
  for (const id of input.includePresets ?? []) {
    if (
      !/^[a-z0-9][a-z0-9-]*$/u.test(id) ||
      ['standard', 'code', 'minimal', 'cordis'].includes(id)
    ) {
      diagnostics.push(packDiagnostic('E_EXPORT_PRESET', 'preset id 不合法或为保留名。', id));
      continue;
    }
    const preset = await collectDirectory(
      join(input.dshHome, '.agent-presets', id),
      `presets/${id}`,
    );
    diagnostics.push(...preset.diagnostics);
    materials.push(...preset.materials);
  }
  if (!input.includeSettings) return { diagnostics, materials, redactions };
  const settings = await text(join(input.dshHome, 'settings.yaml'));
  if (settings === undefined) return { diagnostics, materials, redactions };
  const parsed = parseCanonicalYaml(settings);
  if (
    !parsed.ok ||
    typeof parsed.value?.value !== 'object' ||
    parsed.value.value === null ||
    Array.isArray(parsed.value.value)
  ) {
    diagnostics.push(
      packDiagnostic('E_EXPORT_SETTINGS', 'settings.yaml 不能解析为 mapping。', 'settings.yaml'),
    );
    return { diagnostics, materials, redactions };
  }
  const section = (parsed.value.value as Record<string, unknown>)['agent-presets'];
  if (section === undefined) return { diagnostics, materials, redactions };
  let output = stringify(section);
  const scanned = scanSecrets({
    path: 'settings/agent-presets.yml',
    content: output,
    settingsNamespace: 'agent-presets',
  });
  if (scanned.length > 0 && input.redact) {
    if (scanned.some(({ code }) => code === 'E_SECRET_FILENAME' || code === 'E_SECRET_KEY'))
      diagnostics.push(...scanned);
    else {
      // Quote the sentinel so YAML preserves the exact required string rather than a flow sequence.
      output = redactSecrets(output).replaceAll('[REDACTED]', '"<REDACTED>"');
      redactions.push('settings/agent-presets.yml');
    }
  } else diagnostics.push(...scanned);
  materials.push({ path: 'settings/agent-presets.yml', bytes: Buffer.from(output) });
  return { diagnostics, materials, redactions };
}

export function scanMaterials(materials: readonly Material[]): Diagnostic[] {
  return materials.flatMap(({ bytes, path }) =>
    scanSecrets({ path, content: Buffer.from(bytes).toString('utf8') }),
  );
}
