import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { type ComposeManifest, validateComposeValue } from '@dshpack/core';
import { stringify } from 'yaml';

import { type CommandReport, diagnostic } from '../commands/shared.js';
import { composePack } from '../compose/engine.js';
import {
  isComposeMaterializedSource,
  materializeComposeSource,
  sourceSkills,
} from '../compose/sources.js';
import { EXIT_CODES } from '../exit-codes.js';
import { installPack } from '../install/engine.js';
import type { InstallRuntime } from '../install/runtime-types.js';
import type { UiComposeInput, UiComposePreviewInput, UiComposeSpec } from './wire.js';

export interface UiComposeDependencies {
  readonly compose?: typeof composePack;
  readonly install?: typeof installPack;
  readonly materialize?: typeof materializeComposeSource;
}

function result(
  diagnostics: CommandReport<object>['diagnostics'],
  exitCode: CommandReport<object>['exitCode'],
  metadata: Record<string, unknown>,
): CommandReport<object> {
  return { diagnostics, exitCode, metadata };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}

function composeDigest(value: unknown): string {
  return `sha256-${createHash('sha256').update(canonical(value)).digest('base64url')}`;
}

function isLocalDirectorySource(from: string): boolean {
  return from.startsWith('./') || isAbsolute(from);
}

function isUiSource(from: string): boolean {
  return (
    isLocalDirectorySource(from) ||
    from.startsWith('github:') ||
    /^https:\/\/github\.com\//iu.test(from) ||
    from.startsWith('tarball:')
  );
}

/** Make a user-chosen local directory relative to the server-generated temporary compose file. */
function temporaryReference(root: string, from: string): string {
  if (!isLocalDirectorySource(from)) return from;
  const target = resolve(from);
  const relativePath = relative(root, target).split(sep).join('/');
  return `./${relativePath}`;
}

function manifestFor(root: string, spec: UiComposeSpec): ComposeManifest | undefined {
  // UI composition intentionally exposes only local paths, GitHub refs, and tarball URLs.
  // Profile sources can perform a profile export and are therefore not a zero-write preview input.
  if (spec.include.some((selection) => !isUiSource(selection.from))) return undefined;
  const value = {
    ...spec,
    include: spec.include.map((selection) => ({
      ...selection,
      from: temporaryReference(root, selection.from),
      skills: [...selection.skills],
    })),
    ...(spec.resolve === undefined
      ? {}
      : {
          resolve: spec.resolve.map((item) => ({
            ...item,
            ...(item.prefer === undefined ? {} : { prefer: temporaryReference(root, item.prefer) }),
          })),
        }),
    ...(spec.mcp === undefined ? {} : { mcp: spec.mcp.map((item) => ({ ...item })) }),
  };
  const parsed = validateComposeValue(value);
  return parsed.ok ? parsed.value : undefined;
}

function visibleSelections(
  manifest: ComposeManifest,
  spec: UiComposeSpec,
  selected: readonly { readonly from: string; readonly id: string; readonly originalId: string }[],
) {
  const inputFrom = new Map(
    manifest.include.map((selection, index) => [
      selection.from,
      spec.include[index]?.from ?? selection.from,
    ]),
  );
  return selected.map((item) => ({
    ...item,
    from: item.from.startsWith('github:') ? item.from : (inputFrom.get(item.from) ?? item.from),
  }));
}

function sourceKey(selection: {
  readonly from: string;
  readonly skills: readonly string[];
}): string {
  return JSON.stringify([selection.from, selection.skills]);
}

function isPinnedGitHubSource(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^github:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*#[a-f0-9]{40}$/u.test(value)
  );
}

function frozenComposeSpec(
  spec: UiComposeSpec,
  sources: readonly string[] | undefined,
): UiComposeSpec {
  const resolved = sources ?? [];
  const pinnedForIndex = (index: number): string | undefined => {
    const candidate = resolved[index];
    return isPinnedGitHubSource(candidate) ? candidate : undefined;
  };
  const sourceByInput = new Map(
    spec.include.map((selection, index) => [selection.from, pinnedForIndex(index)]),
  );
  return {
    ...spec,
    include: spec.include.map((selection, index) => ({
      ...selection,
      from: pinnedForIndex(index) ?? selection.from,
    })),
    ...(spec.resolve === undefined
      ? {}
      : {
          resolve: spec.resolve.map((resolution) => ({
            ...resolution,
            ...(resolution.prefer === undefined
              ? {}
              : { prefer: sourceByInput.get(resolution.prefer) ?? resolution.prefer }),
          })),
        }),
  };
}

async function prepare(
  root: string,
  spec: UiComposeSpec,
): Promise<
  { readonly composeFile: string; readonly manifest: ComposeManifest } | CommandReport<object>
> {
  const manifest = manifestFor(root, spec);
  if (manifest === undefined)
    return result(
      [
        diagnostic(
          'E_UI_COMPOSE_SPEC',
          'error',
          'The compose specification is invalid.',
          'Correct the form and retry.',
        ),
      ],
      EXIT_CODES.CONTRACT,
      { phase: 'preview' },
    );
  const composeFile = join(root, 'compose.yml');
  await writeFile(composeFile, stringify(manifest, { lineWidth: 0 }), { mode: 0o600 });
  return { composeFile, manifest };
}

/** Preview materializes only temporary source state; it never targets DSH_HOME for a write. */
export async function previewCompose(
  dshHome: string,
  input: UiComposePreviewInput,
  dependencies: UiComposeDependencies = {},
): Promise<CommandReport<object>> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-'));
  try {
    const prepared = await prepare(root, input.spec);
    if ('exitCode' in prepared) return prepared;
    const available: Array<{ from: string; skills: readonly string[] }> = [];
    const materialize = dependencies.materialize ?? materializeComposeSource;
    const sources = await Promise.all(
      prepared.manifest.include.map((selection) =>
        materialize(selection, prepared.composeFile, dshHome),
      ),
    );
    const cachedBySelection = new Map<string, typeof sources>();
    for (const [index, source] of sources.entries()) {
      const selection = prepared.manifest.include[index];
      if (selection === undefined) continue;
      const key = sourceKey(selection);
      const cached = cachedBySelection.get(key) ?? [];
      cached.push(source);
      cachedBySelection.set(key, cached);
    }
    const handedToCompose = new Set<(typeof sources)[number]>();
    try {
      for (const [index, source] of sources.entries()) {
        if (!isComposeMaterializedSource(source)) continue;
        const selection = prepared.manifest.include[index];
        if (selection !== undefined)
          available.push({
            from: input.spec.include[index]?.from ?? selection.from,
            skills: sourceSkills(source, selection).available,
          });
      }
      const composed = await (dependencies.compose ?? composePack)(
        {
          allowUnknownLicense: true,
          composeFile: prepared.composeFile,
          dshHome,
          dryRun: true,
        },
        {
          materializeSource: async (selection, composeFile, composeDshHome) => {
            const cached = cachedBySelection.get(sourceKey(selection))?.shift();
            if (cached !== undefined) {
              handedToCompose.add(cached);
              return cached;
            }
            return materializeComposeSource(selection, composeFile, composeDshHome);
          },
        },
      );
      const selected = visibleSelections(prepared.manifest, input.spec, composed.metadata.selected);
      const provenance = selected.map((item) => ({
        from: item.from,
        id: item.id,
        originalId: item.originalId,
      }));
      return result(composed.diagnostics, composed.exitCode, {
        phase: 'preview',
        sourceSkills: available,
        selected,
        provenance,
        conflicts: composed.diagnostics.filter((item) =>
          item.code.startsWith('E_COMPOSE_CONFLICT'),
        ),
      });
    } finally {
      await Promise.all(
        sources.flatMap((source) =>
          isComposeMaterializedSource(source) && !handedToCompose.has(source)
            ? [source.cleanup()]
            : [],
        ),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Compose into a private temporary pack, then delegate profile changes to install's transaction. */
export async function composeAndInstall(
  dshHome: string,
  input: UiComposeInput,
  runtime: InstallRuntime,
  phase: 'plan' | 'apply',
  dependencies: UiComposeDependencies = {},
): Promise<CommandReport<object>> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-ui-compose-'));
  try {
    const prepared = await prepare(root, input.spec);
    if ('exitCode' in prepared) return prepared;
    const output = join(root, 'pack');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const composed = await (dependencies.compose ?? composePack)({
      composeFile: prepared.composeFile,
      dshHome,
      output,
    });
    const selected = visibleSelections(prepared.manifest, input.spec, composed.metadata.selected);
    const frozenSpec = frozenComposeSpec(input.spec, composed.metadata.sources);
    if (composed.exitCode !== EXIT_CODES.SUCCESS)
      return result(composed.diagnostics, composed.exitCode, {
        phase,
        compose: { selected },
      });
    const installed = await (dependencies.install ?? installPack)(
      {
        dshHome,
        source: output,
        as: input.profile,
        dryRun: phase === 'plan',
        interactive: phase === 'apply',
        json: phase === 'plan',
      },
      runtime,
    );
    const installationPlan = installed.metadata.plan;
    const stablePlanDigest = composeDigest({
      operation: 'compose',
      profile: input.profile,
      spec: frozenSpec,
      selected,
      pack: installationPlan?.pack,
      targetBeforeState: installationPlan?.rollbackSnapshot.targetBeforeStateDigest,
    });
    return result([...composed.diagnostics, ...installed.diagnostics], installed.exitCode, {
      ...installed.metadata,
      compose: { selected },
      ...(installationPlan === undefined
        ? {}
        : {
            plan: {
              ...installationPlan,
              operation: 'compose',
              compose: { selected, spec: frozenSpec },
              planDigest: stablePlanDigest,
            },
          }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
