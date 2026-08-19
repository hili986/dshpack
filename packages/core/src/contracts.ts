import { type Static, type TObject, type TProperties, Type } from '@sinclair/typebox';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
  hint?: string;
  evidence: 'official' | 'local' | 'needs-test';
}

export interface Result<T> {
  ok: boolean;
  value?: T;
  diagnostics: readonly Diagnostic[];
}

const semanticVersion =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$';
const kebabCase = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const packName = '^(?!web$)(?!headless$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';
const npmPackageName = '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$';
const githubIdentifier = '^[A-Za-z0-9][A-Za-z0-9._-]*$';
const sha512 = '^sha512-[A-Za-z0-9+/]+={0,2}$';
const sha256Base64Url = '^sha256-[A-Za-z0-9_-]+$';
const gitCommit = '^[a-f0-9]{40}$';
const httpsUrl = '^https://[^/@\\s]+(?:/[^\\s]*)?$';

function strictObject<T extends TProperties>(properties: T): TObject<T> {
  return Type.Object(properties, { additionalProperties: false });
}

const NpmPluginSourceSchema = strictObject({
  kind: Type.Literal('npm'),
  range: Type.String({ minLength: 1 }),
});

const GitHubPluginSourceSchema = strictObject({
  kind: Type.Literal('github'),
  owner: Type.String({ pattern: githubIdentifier }),
  repo: Type.String({ pattern: githubIdentifier }),
  ref: Type.String({ pattern: gitCommit }),
});

const TarballPluginSourceSchema = strictObject({
  kind: Type.Literal('tarball'),
  url: Type.String({ pattern: httpsUrl }),
});

export const PluginSourceSchema = Type.Union([
  NpmPluginSourceSchema,
  GitHubPluginSourceSchema,
  TarballPluginSourceSchema,
]);

export const PluginDeclarationSchema = strictObject({
  name: Type.String({ pattern: npmPackageName }),
  source: PluginSourceSchema,
  allowBuilds: Type.Boolean(),
  role: Type.Optional(Type.Union([Type.Literal('bundle'), Type.Literal('mcp-client')])),
});

const DshSchema = strictObject({
  tested: Type.Array(Type.String({ pattern: semanticVersion }), { minItems: 1 }),
  compatibility: Type.Optional(Type.String({ minLength: 1 })),
});

const McpSchema = strictObject({
  serverName: Type.String({ pattern: kebabCase, maxLength: 63 }),
  transport: Type.Union([Type.Literal('streamable-http')]),
  url: Type.String({ pattern: httpsUrl }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 280 })),
});

const DefaultsSchema = strictObject({
  agentPreset: Type.Optional(Type.String({ pattern: kebabCase })),
  permissionPreset: Type.Union([
    Type.Literal('workspace-write'),
    Type.Literal('danger-full-access'),
  ]),
});

const SettingsSchema = strictObject({
  namespaces: strictObject({
    'agent-presets': Type.String({ minLength: 1 }),
  }),
});

const ProvenanceSchema = strictObject({
  id: Type.String({ pattern: kebabCase }),
  from: Type.String({ minLength: 1 }),
  originalId: Type.String({ pattern: kebabCase }),
  license: Type.String({ minLength: 1 }),
});

/** §3.4 pack.yml single source of truth; generated JSON schema is a build artifact. */
export const PackManifestSchema = Type.Object(
  {
    formatVersion: Type.Literal(0),
    name: Type.String({ pattern: packName, minLength: 3, maxLength: 64 }),
    version: Type.String({ pattern: semanticVersion }),
    description: Type.String({ minLength: 1, maxLength: 280 }),
    author: Type.String({ minLength: 1, maxLength: 160 }),
    license: Type.String({ minLength: 1 }),
    homepage: Type.Optional(Type.String({ pattern: httpsUrl })),
    repository: Type.Optional(Type.String({ pattern: httpsUrl })),
    dsh: DshSchema,
    plugins: Type.Array(PluginDeclarationSchema),
    mcp: Type.Array(McpSchema),
    defaults: DefaultsSchema,
    settings: Type.Optional(SettingsSchema),
    provenance: Type.Optional(Type.Array(ProvenanceSchema)),
  },
  {
    $id: 'https://dshpack.dev/schema/pack-v0.json',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
  },
);

const ResolvedPluginSchema = Type.Union([
  strictObject({ version: Type.String({ pattern: semanticVersion }) }),
  strictObject({ commit: Type.String({ pattern: gitCommit }) }),
  strictObject({ url: Type.String({ pattern: httpsUrl }) }),
]);

const IntegritySchema = Type.Union([
  strictObject({ kind: Type.Literal('npm-sri'), value: Type.String({ pattern: sha512 }) }),
  strictObject({ kind: Type.Literal('git-commit'), value: Type.String({ pattern: gitCommit }) }),
  strictObject({ kind: Type.Literal('sha512'), value: Type.String({ pattern: sha512 }) }),
  strictObject({ kind: Type.Literal('unverified'), reason: Type.String({ minLength: 1 }) }),
]);

export const LockedPluginSchema = strictObject({
  name: Type.String({ minLength: 1 }),
  resolved: ResolvedPluginSchema,
  integrity: IntegritySchema,
  packageJsonSha512: Type.String({ pattern: sha512 }),
  bundlePatch: Type.String({ minLength: 1 }),
});

/** §3.5 pack.lock.yml single source of truth; generated JSON schema is a build artifact. */
export const PackLockSchema = Type.Object(
  {
    lockVersion: Type.Literal(0),
    manifestSha256: Type.String({ pattern: sha256Base64Url }),
    generatedBy: Type.String({ minLength: 1 }),
    generatedAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T' }),
    dsh: strictObject({ exportedFrom: Type.String({ pattern: semanticVersion }) }),
    plugins: Type.Array(LockedPluginSchema),
    files: Type.Array(
      strictObject({
        path: Type.String({ minLength: 1 }),
        sha512: Type.String({ pattern: sha512 }),
      }),
    ),
  },
  {
    $id: 'https://dshpack.dev/schema/pack-lock-v0.json',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
  },
);

export type PluginSource = Static<typeof PluginSourceSchema>;
export type PluginDeclaration = Static<typeof PluginDeclarationSchema>;
export type PackManifest = Static<typeof PackManifestSchema>;
/** Facts that can be proven solely from a pnpm lockfile; package JSON facts are added by export later. */
export interface LockedPlugin {
  name: string;
  resolved: { version: string } | { commit: string } | { url: string };
  integrity:
    | { kind: 'npm-sri'; value: string }
    | { kind: 'git-commit'; value: string }
    | { kind: 'sha512'; value: string };
}
export type PackLockedPlugin = Static<typeof LockedPluginSchema>;
export type PackLock = Static<typeof PackLockSchema>;
