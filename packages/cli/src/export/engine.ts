import { join } from 'node:path';

import { type Diagnostic, type PackManifest, preparePatchExport } from '@dshpack/core';
import { stringify } from 'yaml';

import { runDsh } from '../adapters/process.js';
import { type CommandReport, exitCodeFor, strictDiagnostics } from '../commands/shared.js';
import { dshOptions, readProfile, text } from '../doctor/support.js';
import { EXIT_CODES } from '../exit-codes.js';
import { validateLocalPack } from '../validation/validate-pack.js';
import { GENERATED_BY } from '../version.js';
import {
  buildPluginFacts,
  collectOptionalAssets,
  packDiagnostic,
  scanMaterials,
  testedVersion,
} from './collect.js';
import {
  abandonTemporary,
  fileName,
  type Material,
  mcpFromPatch,
  prepareOutput,
  publishTemporary,
  scanProfileNames,
  sha256,
  sha512,
  writeMaterials,
} from './support.js';
import type { ExportInput, ExportReport } from './types.js';

export type { ExportInput, ExportReport } from './types.js';

function metadata(
  input: ExportInput,
  profile: string,
  exportMode: ExportReport['exportMode'] = 'opaque-profile-patch',
  integrity: ExportReport['integrity'] = 'unverified',
  redactions: readonly string[] = [],
): ExportReport {
  return {
    exportMode,
    integrity,
    output: input.output,
    profile,
    redactions,
    review: [],
    sideEffects: ['profile/cordis.yml'],
  };
}

/** Export a profile into a self-validating, atomically published local v0 pack. */
export async function exportProfile(input: ExportInput): Promise<CommandReport<ExportReport>> {
  const diagnostics: Diagnostic[] = [];
  const profileName = input.profile;
  if (profileName === undefined || profileName.length === 0) {
    return {
      diagnostics: [packDiagnostic('E_EXPORT_PROFILE', '--profile 必填，绝不猜当前 profile。')],
      exitCode: EXIT_CODES.USAGE,
      metadata: metadata(input, ''),
    };
  }
  const profile = await readProfile(input.dshHome, profileName);
  diagnostics.push(...profile.diagnostics);
  if (profile.facts === undefined) {
    return { diagnostics, exitCode: EXIT_CODES.CONTRACT, metadata: metadata(input, profileName) };
  }
  diagnostics.push(...(await scanProfileNames(profile.facts.root)));
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    return {
      diagnostics,
      exitCode: exitCodeFor(diagnostics),
      metadata: metadata(input, profileName),
    };
  }

  let dshVersion: string | undefined;
  let defaultDump: string | undefined;
  try {
    const version = await runDsh(['--version'], {
      cwd: profile.facts.root,
      dshHome: input.dshHome,
      timeout: 5_000,
      ...dshOptions(input),
    });
    dshVersion = testedVersion(version.stdout);
    const dump = await runDsh(['--profile', profileName, '--dump-default-config'], {
      cwd: profile.facts.root,
      dshHome: input.dshHome,
      timeout: 5_000,
      ...dshOptions(input),
    });
    defaultDump = dump.stdout;
  } catch {
    diagnostics.push(
      packDiagnostic(
        'E_EXPORT_DSH',
        '无法获取 dsh 版本或 default dump。',
        '确认 dsh/profile 可用；该操作会由 dsh 写 profile/cordis.yml。',
      ),
    );
  }
  if (dshVersion === undefined || defaultDump === undefined) {
    return {
      diagnostics,
      exitCode: EXIT_CODES.DSH_SUBPROCESS_FAILURE,
      metadata: metadata(input, profileName),
    };
  }

  const patch = preparePatchExport(defaultDump, profile.facts.patch);
  diagnostics.push(...patch.diagnostics);
  if (patch.value === undefined) {
    return { diagnostics, exitCode: EXIT_CODES.CONTRACT, metadata: metadata(input, profileName) };
  }
  const mcp = mcpFromPatch(profile.facts.patch);
  diagnostics.push(...mcp.diagnostics);
  const lockSource = await text(join(profile.facts.root, 'pnpm-lock.yaml'));
  const pluginFacts = await buildPluginFacts(
    profile.facts.root,
    profile.facts.dependencies,
    profile.facts.bundles,
    lockSource,
    input.allowUnverifiedExport === true,
  );
  diagnostics.push(...pluginFacts.diagnostics);
  const optional = await collectOptionalAssets(input);
  diagnostics.push(...optional.diagnostics);
  const patchText =
    patch.value.exportMode === 'opaque-profile-patch'
      ? patch.value.patch
      : stringify(patch.value.patch);
  const materials: Material[] = [
    { path: 'patch/cordis.patch.yml', bytes: Buffer.from(patchText) },
    ...optional.materials,
  ];
  diagnostics.push(...scanMaterials(materials));
  const integrity: ExportReport['integrity'] = pluginFacts.unverified ? 'unverified' : 'verified';
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    return {
      diagnostics,
      exitCode: exitCodeFor(diagnostics),
      metadata: metadata(
        input,
        profileName,
        patch.value.exportMode,
        integrity,
        optional.redactions,
      ),
    };
  }

  const manifest: PackManifest = {
    formatVersion: 0,
    name: profileName,
    version: '0.1.0',
    description: `从 profile ${profileName} 导出的 dsh 场景包。`,
    author: 'dshpack export',
    license: 'UNLICENSED',
    dsh: { tested: [dshVersion] },
    plugins: pluginFacts.plugins,
    mcp: mcp.mcp,
    defaults: { permissionPreset: 'workspace-write' },
    ...(optional.materials.some(({ path }) => path === 'settings/agent-presets.yml')
      ? { settings: { namespaces: { 'agent-presets': 'agent-presets.yml' } } }
      : {}),
  };
  const packText = stringify(manifest);
  const review = [
    'patch/cordis.patch.yml',
    ...materials.filter(({ path }) => fileName(path) === 'SKILL.md').map(({ path }) => path),
  ];
  const report: ExportReport = {
    ...metadata(input, profileName, patch.value.exportMode, integrity, optional.redactions),
    review,
  };
  const reportFile = { ...report, output: '<local-output>' };
  materials.push({
    path: 'export-report.json',
    bytes: Buffer.from(`${JSON.stringify(reportFile, null, 2)}\n`),
  });
  const lock = {
    lockVersion: 0,
    manifestSha256: sha256(Buffer.from(packText)),
    generatedBy: GENERATED_BY,
    generatedAt: new Date().toISOString(),
    dsh: { exportedFrom: dshVersion },
    plugins: pluginFacts.locked,
    files: materials.map(({ path, bytes }) => ({ path, sha512: sha512(bytes) })),
  };
  const temporary = await prepareOutput(input.output, input.yes === true);
  diagnostics.push(...temporary.diagnostics);
  if (temporary.temporary === undefined) {
    return { diagnostics, exitCode: EXIT_CODES.USER_DECLINED, metadata: report };
  }
  try {
    await writeMaterials(temporary.temporary, [
      { path: 'pack.yml', bytes: Buffer.from(packText) },
      ...materials,
      { path: 'pack.lock.yml', bytes: Buffer.from(stringify(lock)) },
    ]);
    diagnostics.push(
      ...scanMaterials([{ path: 'pack.yml', bytes: Buffer.from(packText) }, ...materials]),
    );
    const validated = await validateLocalPack(temporary.temporary, { strict: true });
    diagnostics.push(...validated.diagnostics);
    if (diagnostics.some(({ severity }) => severity === 'error')) {
      await abandonTemporary(temporary.temporary);
      return { diagnostics, exitCode: exitCodeFor(diagnostics), metadata: report };
    }
    await publishTemporary(temporary.temporary, input.output);
    return {
      diagnostics: strictDiagnostics(diagnostics, false),
      exitCode: EXIT_CODES.SUCCESS,
      metadata: report,
    };
  } catch {
    await abandonTemporary(temporary.temporary);
    diagnostics.push(packDiagnostic('E_EXPORT_WRITE', '无法原子写入 export 输出。', input.output));
    return { diagnostics, exitCode: EXIT_CODES.CONTRACT, metadata: report };
  }
}
