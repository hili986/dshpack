import { describe, expect, it } from 'vitest';

import { redactSecrets, scanSecrets, validateMcpEnvValues } from '../src/index.js';

const syntheticToken = 'sk-TESTONLY-00000000000000000000000000000000';
const envReference = '$' + '{ENV_VAR}';
const context7EnvReference = '$' + '{CONTEXT7_API_KEY}';

describe('four-layer secret scanning', () => {
  it.each([
    '.credentials.yaml',
    '.env',
    '.env.production',
    '.npmrc',
    '.pypirc',
    'id_rsa_backup',
    'cert.pem',
    'secret.key',
    'identity.p12',
    'run.session.json',
    '.git/config',
    'node_modules/pkg/package.json',
    'profiles/demo/pnpm-lock.yaml',
  ])('rejects forbidden filename %s', (path) => {
    expect(
      scanSecrets({ path }).some((diagnostic) => diagnostic.code === 'E_SECRET_FILENAME'),
    ).toBe(true);
  });

  it.each([
    'apiKey',
    'api_key',
    'accessToken',
    'SECRET_VALUE',
    'password',
    'authorization',
    'cookie',
    'privateKey',
    'clientSecret',
  ])('rejects sensitive key %s without echoing its value', (key) => {
    const diagnostics = scanSecrets({
      path: 'settings/agent-presets.yml',
      content: `${key}: harmless\n`,
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'E_SECRET_KEY', path: expect.stringMatching(/:1:1$/u) }),
    ]);
  });

  it.each([
    ['private key', 'key: BEGIN PRIVATE KEY\n', 'E_SECRET_PRIVATE_KEY'],
    ['GitHub token', 'key: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n', 'E_SECRET_TOKEN'],
    ['DeepSeek synthetic token', `key: ${syntheticToken}\n`, 'E_SECRET_TOKEN'],
    ['npm token', 'key: npm_abcdefghijklmnopqrstuvwxyz0123456789\n', 'E_SECRET_TOKEN'],
    ['Bearer authorization', 'key: Bearer synthetic-access-token\n', 'E_SECRET_AUTHORIZATION'],
    ['Basic authorization', 'key: Basic c3ludGhldGljOnBhc3M=\n', 'E_SECRET_AUTHORIZATION'],
    [
      'URL userinfo',
      'endpoint: https://synthetic-user:synthetic-pass@example.test/mcp\n',
      'E_SECRET_URL_USERINFO',
    ],
    ['high entropy string', 'key: zQ9vLm2aBx7Rt4YpNc8Kd1WsFe6Hu3Gi\n', 'E_SECRET_HIGH_ENTROPY'],
  ])('detects %s as a value-level secret', (_name, content, code) => {
    expect(
      scanSecrets({ path: 'settings/agent-presets.yml', content }).some(
        (diagnostic) => diagnostic.code === code,
      ),
    ).toBe(true);
  });

  it.each([
    ['AWS access key ID', 'AKIAIOSFODNN7EXAMPLE'],
    ['AWS session key ID', 'ASIAIOSFODNN7EXAMPLE'],
    ['Google API key', `AIza${'a'.repeat(35)}`],
    ['Stripe secret key', `sk_live_${'a'.repeat(24)}`],
    ['Stripe publishable key', `pk_live_${'a'.repeat(24)}`],
    ['Stripe restricted key', `rk_live_${'a'.repeat(24)}`],
    ['Slack bot token', `xoxb-${'a'.repeat(24)}`],
    ['Slack app token', `xoxa-${'a'.repeat(24)}`],
    ['Slack user token', `xoxp-${'a'.repeat(24)}`],
    ['Slack refresh token', `xoxr-${'a'.repeat(24)}`],
    ['Slack socket token', `xoxs-${'a'.repeat(24)}`],
    ['OpenAI project key', `sk-proj-${'a'.repeat(24)}`],
  ])('detects known cloud credential shape %s even under a non-sensitive key', (_name, value) => {
    expect(
      scanSecrets({ path: 'settings/agent-presets.yml', content: `value: ${value}\n` }).some(
        (diagnostic) => diagnostic.code === 'E_SECRET_TOKEN',
      ),
    ).toBe(true);
  });

  it.each([
    ['40-character commit SHA', '0123456789abcdef0123456789abcdef01234567'],
    ['sha512 integrity', `sha512-${'a'.repeat(86)}`],
    ['verified package name', '@deepseek-ai/dsh-mcp-client'],
  ])('does not mistake a %s for a credential', (_name, value) => {
    expect(scanSecrets({ path: 'pack.yml', content: `value: ${value}\n` })).toEqual([]);
  });

  it('enforces the v0 settings namespace whitelist', () => {
    expect(scanSecrets({ path: 'settings/other.yml', settingsNamespace: 'other' })).toEqual([
      expect.objectContaining({ code: 'E_SETTINGS_NAMESPACE' }),
    ]);
    expect(
      scanSecrets({ path: 'settings/agent-presets.yml', settingsNamespace: 'agent-presets' }),
    ).toEqual([]);
  });

  it(`allows only ${envReference} values in mcp.env`, () => {
    expect(
      validateMcpEnvValues({ API_KEY: context7EnvReference }, 'settings/agent-presets.yml'),
    ).toEqual([]);
    expect(
      validateMcpEnvValues({ API_KEY: 'literal-value' }, 'settings/agent-presets.yml'),
    ).toEqual([expect.objectContaining({ code: 'E_SETTINGS_MCP_ENV' })]);
  });
});

describe('secret diagnostic non-disclosure guard', () => {
  it('never exposes a synthetic token or any of its >=8-character substrings in diagnostics or JSON', () => {
    const diagnostics = scanSecrets({
      path: 'settings/agent-presets.yml',
      content: `apiKey: ${syntheticToken}\nendpoint: https://synthetic-user:synthetic-pass@example.test/mcp\n`,
    });
    expect(diagnostics.length).toBeGreaterThan(0);

    const publicOutput = diagnostics.map(({ message, hint, path }) => ({ message, hint, path }));
    const serialized = JSON.stringify({ diagnostics: publicOutput });
    for (let start = 0; start <= syntheticToken.length - 8; start += 1) {
      const fragment = syntheticToken.slice(start, start + 8);
      expect(serialized).not.toContain(fragment);
    }
  });
});

describe('secret log redaction', () => {
  it('removes secrets while retaining non-sensitive context', () => {
    const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const entropySecret = 'zQ9vLm2aBx7Rt4YpNc8Kd1WsFe6Hu3Gi';
    const input = [
      'child started',
      `Authorization: Bearer ${syntheticToken}`,
      `endpoint=https://synthetic-user:synthetic-pass@example.test/mcp`,
      `api_key: ${githubToken}`,
      `opaque=${entropySecret}`,
      '-----BEGIN PRIVATE KEY-----',
      'synthetic-private-material',
      '-----END PRIVATE KEY-----',
      'child finished',
    ].join('\n');

    const redacted = redactSecrets(input);

    expect(redacted).toContain('child started');
    expect(redacted).toContain('child finished');
    expect(redacted).toContain('[REDACTED]');
    for (const secret of [
      syntheticToken,
      githubToken,
      entropySecret,
      'synthetic-user',
      'synthetic-pass',
      'synthetic-private-material',
    ]) {
      expect(redacted).not.toContain(secret);
    }
  });
});
