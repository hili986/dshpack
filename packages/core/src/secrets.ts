import type { Diagnostic } from './contracts.js';

export interface SecretScanInput {
  path: string;
  content?: string;
  settingsNamespace?: string;
}

const sensitiveKey =
  /api[-_]?key|token|secret|password|authorization|cookie|private[-_]?key|client[-_]?secret/iu;
const tokenPattern =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9_-]{16,})\b/gu;
const authorizationPattern = /\b(?:Bearer|Basic)\s+[^\s]+/giu;
const urlUserinfoPattern = /https?:\/\/[^/\s:@]+:[^@/\s]+@/giu;
const highEntropyCandidate = /[A-Za-z0-9+/_=-]{24,}/gu;
const envReference = '$' + '{ENV_VAR}';

function at(path: string, line: number, column: number): string {
  return `${path}:${line}:${column}`;
}

function error(code: string, message: string, hint: string, path: string): Diagnostic {
  return { code, severity: 'error', message, hint, path, evidence: 'local' };
}

function lineColumn(content: string, offset: number): { line: number; column: number } {
  const prefix = content.slice(0, offset);
  const line = prefix.split('\n').length;
  const lastNewline = prefix.lastIndexOf('\n');
  return { line, column: offset - lastNewline };
}

function isForbiddenFilename(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  const base = segments.at(-1) ?? '';
  return (
    segments.includes('.git') ||
    segments.includes('node_modules') ||
    base === '.credentials.yaml' ||
    base === '.env' ||
    base.startsWith('.env.') ||
    base === '.npmrc' ||
    base === '.pypirc' ||
    base.startsWith('id_rsa') ||
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    base.endsWith('.p12') ||
    base.includes('.session') ||
    (base === 'pnpm-lock.yaml' && segments.includes('profiles'))
  );
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function appendValueMatches(
  diagnostics: Diagnostic[],
  content: string,
  path: string,
  pattern: RegExp,
  code: string,
  message: string,
  hint: string,
): void {
  for (const match of content.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined) continue;
    const position = lineColumn(content, index);
    diagnostics.push(error(code, message, hint, at(path, position.line, position.column)));
  }
}

/** Scan filename, YAML-like keys, values, and the settings namespace without exposing any matched value. */
export function scanSecrets(input: SecretScanInput): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (isForbiddenFilename(input.path)) {
    diagnostics.push(
      error(
        'E_SECRET_FILENAME',
        '文件名属于禁止纳入的凭据或运行时文件。',
        '从 pack payload 中排除此文件。',
        input.path,
      ),
    );
  }
  if (input.settingsNamespace !== undefined && input.settingsNamespace !== 'agent-presets') {
    diagnostics.push(
      error(
        'E_SETTINGS_NAMESPACE',
        'settings 仅允许 agent-presets namespace。',
        '改为 agent-presets 或不要导出该 settings 文件。',
        input.path,
      ),
    );
  }
  if (input.content === undefined) return diagnostics;

  const lines = input.content.split('\n');
  for (const [index, line] of lines.entries()) {
    const key = /^\s*([^#:\s][^:]*):/u.exec(line);
    if (key?.[1] !== undefined && sensitiveKey.test(key[1])) {
      const column = line.indexOf(key[1]) + 1;
      diagnostics.push(
        error(
          'E_SECRET_KEY',
          '配置键名表明该值可能是凭据。',
          '移除该键或改为运行时环境变量引用。',
          at(input.path, index + 1, column),
        ),
      );
    }
  }

  appendValueMatches(
    diagnostics,
    input.content,
    input.path,
    /BEGIN(?: [A-Z]+)* PRIVATE KEY/gu,
    'E_SECRET_PRIVATE_KEY',
    '检测到私钥内容。',
    '移除私钥，改为运行时凭据注入。',
  );
  appendValueMatches(
    diagnostics,
    input.content,
    input.path,
    tokenPattern,
    'E_SECRET_TOKEN',
    '检测到 token 格式的值。',
    '移除 token，改为运行时环境变量引用。',
  );
  appendValueMatches(
    diagnostics,
    input.content,
    input.path,
    authorizationPattern,
    'E_SECRET_AUTHORIZATION',
    '检测到 Authorization 格式的值。',
    '移除 Authorization 值，改为运行时环境变量引用。',
  );
  appendValueMatches(
    diagnostics,
    input.content,
    input.path,
    urlUserinfoPattern,
    'E_SECRET_URL_USERINFO',
    'URL 不能包含 userinfo 凭据。',
    '移除 URL 中的用户名和密码。',
  );
  for (const match of input.content.matchAll(highEntropyCandidate)) {
    const value = match[0];
    const index = match.index;
    if (index === undefined || shannonEntropy(value) < 3.5) continue;
    const position = lineColumn(input.content, index);
    diagnostics.push(
      error(
        'E_SECRET_HIGH_ENTROPY',
        '检测到高熵凭据形态的值。',
        '改为运行时环境变量引用。',
        at(input.path, position.line, position.column),
      ),
    );
  }
  return diagnostics;
}

/** §3.3 permits only a literal ${ENV_VAR} reference in v0 MCP environment values. */
export function validateMcpEnvValues(
  env: Readonly<Record<string, unknown>>,
  path: string,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && /^\$\{[A-Z_][A-Z0-9_]*\}$/u.test(value)) continue;
    diagnostics.push(
      error(
        'E_SETTINGS_MCP_ENV',
        `mcp.env 的值必须是 ${envReference} 引用。`,
        `将 ${key} 改为 ${envReference} 形式。`,
        path,
      ),
    );
  }
  return diagnostics;
}
