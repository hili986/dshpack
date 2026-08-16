import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { type Document, isAlias, isMap, isNode, isSeq, parseAllDocuments } from 'yaml';

import {
  type Diagnostic,
  type PackLock,
  PackLockSchema,
  type PackManifest,
  PackManifestSchema,
  type Result,
} from './contracts.js';

export interface CanonicalYaml {
  document: Document.Parsed;
  value: unknown;
}

export interface ParseYamlOptions {
  /** Reserved for W7 patch input only; this reader never evaluates the tag. */
  allowJsTag?: boolean;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validatePack = ajv.compile(PackManifestSchema);
const validateLock = ajv.compile(PackLockSchema);

function failure<T>(diagnostics: readonly Diagnostic[]): Result<T> {
  return { ok: false, diagnostics };
}

function success<T>(value: T): Result<T> {
  return { ok: true, value, diagnostics: [] };
}

function diagnostic(code: string, message: string, hint: string, path?: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    ...(path === undefined ? {} : { path }),
    hint,
    evidence: 'local',
  };
}

function nodeIssue(node: unknown, allowJsTag: boolean): 'alias' | 'tag' | undefined {
  if (!isNode(node)) return undefined;
  if (isAlias(node)) return 'alias';
  if (node.tag !== undefined) {
    const isJs = node.tag === 'tag:yaml.org,2002:js';
    const isCore = node.tag.startsWith('tag:yaml.org,2002:') && !isJs;
    if (!isCore && !(allowJsTag && isJs)) return 'tag';
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      const keyIssue = nodeIssue(pair.key, allowJsTag);
      if (keyIssue !== undefined) return keyIssue;
      const valueIssue = nodeIssue(pair.value, allowJsTag);
      if (valueIssue !== undefined) return valueIssue;
    }
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      const itemIssue = nodeIssue(item, allowJsTag);
      if (itemIssue !== undefined) return itemIssue;
    }
  }
  return undefined;
}

function parserError(error: Error): Diagnostic {
  const message = error.message;
  if (message.includes('Map keys must be unique')) {
    return diagnostic('E_YAML_DUPLICATE_KEY', 'YAML 映射包含重复键。', '删除或重命名重复键。');
  }
  return diagnostic('E_YAML_PARSE', 'YAML 语法不能解析。', '修正该 YAML 语法后重试。');
}

/** Parse exactly one YAML 1.2 document while retaining its CST-backed Document and comments. */
export function parseCanonicalYaml(
  source: string,
  options: ParseYamlOptions = {},
): Result<CanonicalYaml> {
  if (source.includes('\r')) {
    return failure([
      diagnostic('E_YAML_LINE_ENDING', 'YAML 必须使用 LF 换行。', '将 CRLF 转换为 LF。'),
    ]);
  }

  const documents = parseAllDocuments(source, {
    version: '1.2',
    uniqueKeys: true,
    merge: false,
    keepSourceTokens: true,
    strict: true,
  });
  if (documents.length !== 1) {
    return failure([
      diagnostic(
        'E_YAML_MULTIPLE_DOCUMENTS',
        'pack 文件只能包含一个 YAML 文档。',
        '删除额外的 --- 或 ... 文档分隔符。',
      ),
    ]);
  }

  const document = documents[0];
  if (document === undefined) {
    return failure([diagnostic('E_YAML_PARSE', 'YAML 文档为空。', '写入一个 YAML mapping。')]);
  }
  if (document.errors.length > 0) return failure(document.errors.map(parserError));

  const issue = nodeIssue(document.contents, options.allowJsTag === true);
  if (issue === 'alias') {
    return failure([
      diagnostic('E_YAML_ALIAS', 'pack YAML 不允许 alias。', '展开 alias 为显式值。'),
    ]);
  }
  if (issue === 'tag') {
    return failure([
      diagnostic(
        'E_YAML_TAG',
        'pack YAML 包含不允许的 tag。',
        '移除未知 tag；仅 W7 patch 可显式允许 !!js。',
      ),
    ]);
  }
  return success({ document, value: document.toJS({ maxAliasCount: 0 }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointer(path: string, leaf?: string): string {
  return `${path || '/'}${leaf === undefined ? '' : `/${leaf}`}`;
}

function ajvDiagnostic(error: ErrorObject): Diagnostic {
  const params = error.params as Record<string, unknown>;
  const path =
    error.keyword === 'required'
      ? pointer(error.instancePath, String(params.missingProperty))
      : error.instancePath || '/';
  if (error.keyword === 'required') {
    const field = String(params.missingProperty);
    return diagnostic(
      'E_SCHEMA_REQUIRED',
      `缺少必填字段 “${field}”。`,
      `补充 ${path} 字段。`,
      path,
    );
  }
  if (error.keyword === 'additionalProperties') {
    const field = String(params.additionalProperty);
    return diagnostic(
      'E_SCHEMA_UNKNOWN_FIELD',
      `不允许未知字段 “${field}”。`,
      `删除 ${pointer(error.instancePath, field)}。`,
      pointer(error.instancePath, field),
    );
  }
  if (error.keyword === 'enum' || error.keyword === 'const') {
    return diagnostic(
      'E_SCHEMA_ENUM',
      `字段 ${path} 的值不在允许范围内。`,
      '改为 schema 声明的枚举值。',
      path,
    );
  }
  if (error.keyword === 'pattern') {
    return diagnostic(
      'E_SCHEMA_PATTERN',
      `字段 ${path} 的格式不满足约束。`,
      '按 pack v0 规定修改该字段。',
      path,
    );
  }
  if (error.keyword === 'minLength' || error.keyword === 'minItems') {
    return diagnostic(
      'E_SCHEMA_MINIMUM',
      `字段 ${path} 缺少最少必需内容。`,
      '补充至少一个有效值。',
      path,
    );
  }
  return diagnostic(
    'E_SCHEMA_TYPE',
    `字段 ${path} 的类型不符合要求。`,
    '改为 schema 要求的类型。',
    path,
  );
}

function validate<T>(
  value: unknown,
  validator: ValidateFunction<T>,
  formatField: string,
): Result<T> {
  if (isRecord(value) && typeof value[formatField] === 'number' && value[formatField] > 0) {
    return failure([
      diagnostic(
        'E_FORMAT_TOO_NEW',
        `${formatField} 版本高于当前支持的 v0。`,
        `使用 ${formatField}: 0 或升级 dshpack。`,
        `/${formatField}`,
      ),
    ]);
  }
  if (validator(value)) return success(value);
  const errors = (validator.errors ?? [])
    .filter((error) => error.keyword !== 'anyOf')
    .map(ajvDiagnostic);
  return failure(
    errors.length === 0
      ? [diagnostic('E_SCHEMA_TYPE', '文档类型不符合 schema。', '改为 v0 schema 所要求的对象。')]
      : errors,
  );
}

export function validatePackValue(value: unknown): Result<PackManifest> {
  const result = validate(value, validatePack, 'formatVersion');
  if (!result.ok || result.value === undefined) return result;

  const diagnostics: Diagnostic[] = [];
  const pluginNames = new Set<string>();
  for (const [index, plugin] of result.value.plugins.entries()) {
    if (pluginNames.has(plugin.name)) {
      diagnostics.push(
        diagnostic(
          'E_SCHEMA_DUPLICATE',
          'plugins 中的 name 必须唯一。',
          '删除或重命名重复的插件声明。',
          `/plugins/${index}/name`,
        ),
      );
    }
    pluginNames.add(plugin.name);
  }

  const serverNames = new Set<string>();
  for (const [index, mcp] of result.value.mcp.entries()) {
    if (serverNames.has(mcp.serverName)) {
      diagnostics.push(
        diagnostic(
          'E_SCHEMA_DUPLICATE',
          'mcp 中的 serverName 必须唯一。',
          '删除或重命名重复的 MCP server。',
          `/mcp/${index}/serverName`,
        ),
      );
    }
    serverNames.add(mcp.serverName);
  }
  return diagnostics.length === 0 ? result : failure(diagnostics);
}

export function validateLockValue(value: unknown): Result<PackLock> {
  return validate(value, validateLock, 'lockVersion');
}

export function parsePack(source: string): Result<PackManifest> {
  const parsed = parseCanonicalYaml(source);
  return parsed.ok ? validatePackValue(parsed.value?.value) : failure(parsed.diagnostics);
}

export function parseLock(source: string): Result<PackLock> {
  const parsed = parseCanonicalYaml(source);
  return parsed.ok ? validateLockValue(parsed.value?.value) : failure(parsed.diagnostics);
}
