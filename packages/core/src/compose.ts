import { type Static, Type } from '@sinclair/typebox';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import type { Diagnostic, Result } from './contracts.js';
import { parseCanonicalYaml } from './pack.js';

const semanticVersion =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$';
const kebabCase = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const packName = '^(?!web$)(?!headless$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';
const httpsUrl = '^https://[^/@\\s]+(?:/[^\\s]*)?$';
const composeSource =
  '^(?:profile:[a-z0-9][a-z0-9-]*|github:[A-Za-z0-9][A-Za-z0-9._-]*\\/[A-Za-z0-9][A-Za-z0-9._-]*#[a-f0-9]{40}|tarball:(?:https://|file:|\\./).+|\\./.+)$';

function strictObject<T extends Record<string, ReturnType<typeof Type.Unsafe>>>(
  properties: T,
): ReturnType<typeof Type.Object<T>> {
  return Type.Object(properties, { additionalProperties: false });
}

const ComposeIncludeSchema = strictObject({
  from: Type.String({ pattern: composeSource }),
  skills: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

const ComposeResolutionSchema = strictObject({
  id: Type.String({ pattern: kebabCase }),
  rename: Type.Optional(Type.String({ pattern: kebabCase })),
  prefer: Type.Optional(Type.String({ pattern: composeSource })),
});

const ComposeMcpSchema = strictObject({
  serverName: Type.String({ pattern: kebabCase, maxLength: 63 }),
  transport: Type.Literal('streamable-http'),
  url: Type.String({ pattern: httpsUrl }),
});

const ComposeDefaultsSchema = strictObject({
  permissionPreset: Type.Union([
    Type.Literal('workspace-write'),
    Type.Literal('danger-full-access'),
  ]),
});

/** The v0 single source of truth for compose.yml. */
export const ComposeManifestSchema = Type.Object(
  {
    composeVersion: Type.Literal(0),
    name: Type.String({ pattern: packName, minLength: 3, maxLength: 64 }),
    version: Type.String({ pattern: semanticVersion }),
    description: Type.String({ minLength: 1, maxLength: 280 }),
    author: Type.String({ minLength: 1, maxLength: 160 }),
    license: Type.String({ minLength: 1 }),
    include: Type.Array(ComposeIncludeSchema, { minItems: 1 }),
    resolve: Type.Optional(Type.Array(ComposeResolutionSchema)),
    mcp: Type.Optional(Type.Array(ComposeMcpSchema)),
    defaults: ComposeDefaultsSchema,
  },
  { additionalProperties: false },
);

export type ComposeManifest = Static<typeof ComposeManifestSchema>;

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validate = ajv.compile(ComposeManifestSchema);

function failure<T>(diagnostics: readonly Diagnostic[]): Result<T> {
  return { ok: false, diagnostics };
}

function issue(error: ErrorObject): Diagnostic {
  const params = error.params as Record<string, unknown>;
  const path =
    error.keyword === 'required'
      ? `${error.instancePath || ''}/${String(params.missingProperty)}`
      : error.instancePath || '/';
  return {
    code: error.keyword === 'additionalProperties' ? 'E_SCHEMA_UNKNOWN_FIELD' : 'E_SCHEMA_TYPE',
    severity: 'error',
    message:
      error.keyword === 'additionalProperties'
        ? `不允许未知字段 “${String(params.additionalProperty)}”。`
        : `字段 ${path} 不符合 compose v0 schema。`,
    hint: '修正 compose.yml 后重试。',
    path,
    evidence: 'local',
  };
}

/** Validate compose.yml and reject ambiguous rename/prefer directives. */
export function validateComposeValue(value: unknown): Result<ComposeManifest> {
  if (typeof value === 'object' && value !== null) {
    const version = (value as { composeVersion?: unknown }).composeVersion;
    if (typeof version === 'number' && version > 0) {
      return failure([
        {
          code: 'E_FORMAT_TOO_NEW',
          severity: 'error',
          message: 'composeVersion 高于当前支持的 v0。',
          hint: '使用 composeVersion: 0 或升级 dshpack。',
          path: '/composeVersion',
          evidence: 'local',
        },
      ]);
    }
  }
  if (!validate(value)) return failure((validate.errors ?? []).map(issue));
  const manifest = value as ComposeManifest;
  const diagnostics: Diagnostic[] = [];
  for (const [index, resolution] of (manifest.resolve ?? []).entries()) {
    if ((resolution.rename === undefined) === (resolution.prefer === undefined)) {
      diagnostics.push({
        code: 'E_COMPOSE_RESOLVE',
        severity: 'error',
        message: '每条 resolve 必须且只能指定 rename 或 prefer。',
        hint: '为冲突 id 选择一个明确的重命名或来源偏好。',
        path: `/resolve/${index}`,
        evidence: 'local',
      });
    }
  }
  return diagnostics.length === 0
    ? { ok: true, value: manifest, diagnostics: [] }
    : failure(diagnostics);
}

/** Parse exactly one canonical YAML compose document. */
export function parseCompose(source: string): Result<ComposeManifest> {
  const parsed = parseCanonicalYaml(source);
  return parsed.ok ? validateComposeValue(parsed.value?.value) : failure(parsed.diagnostics);
}
