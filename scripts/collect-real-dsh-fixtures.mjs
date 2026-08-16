import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [probeRootArgument, outputRootArgument] = process.argv.slice(2);
if (!probeRootArgument || !outputRootArgument) {
  throw new Error('usage: node scripts/collect-real-dsh-fixtures.mjs <probe-root> <output-root>');
}

const probeRoot = resolve(probeRootArgument);
const outputRoot = resolve(outputRootArgument);
const probeDshHome = join(probeRoot, 'dsh-home');
const workspaceRoot = resolve('.');

const fixtures = [
  {
    source: join(probeDshHome, 'profiles/e1-fresh/package.json'),
    destination: 'e1-profile/package.json',
    command: '<DSH_BIN> plugin --profile e1-fresh list --depth=0',
  },
  {
    source: join(probeDshHome, 'profiles/e1-fresh/cordis.patch.yml'),
    destination: 'e1-profile/cordis.patch.yml',
    command: '<DSH_BIN> plugin --profile e1-fresh list --depth=0',
  },
  {
    source: join(probeDshHome, 'profiles/e1-fresh/pnpm-workspace.yaml'),
    destination: 'e1-profile/pnpm-workspace.yaml',
    command: '<DSH_BIN> plugin --profile e1-fresh list --depth=0',
  },
  {
    source: join(probeDshHome, 'profiles/e3-npm/pnpm-lock.yaml'),
    destination: 'e3-npm/pnpm-lock.yaml',
    command: '<DSH_BIN> plugin --profile e3-npm add yocto-queue@1.2.2',
  },
  {
    source: join(probeDshHome, 'profiles/e3-git/pnpm-lock.yaml'),
    destination: 'e3-git/pnpm-lock.yaml',
    command:
      '<DSH_BIN> plugin --profile e3-git add github:sindresorhus/yocto-queue#b07eac099753833b29d06c614149904445739776',
  },
  {
    source: join(probeDshHome, 'profiles/e3-tarball-direct/pnpm-lock.yaml'),
    destination: 'e3-tarball/pnpm-lock.yaml',
    command:
      '<DSH_BIN> plugin --profile e3-tarball-direct add https://github.com/sindresorhus/yocto-queue/archive/b07eac099753833b29d06c614149904445739776.tar.gz',
  },
  {
    source: join(probeDshHome, 'profiles/e5-mcp/cordis.patch.yml'),
    destination: 'e5-mcp/cordis.patch.yml',
    command: '<DSH_BIN> --profile e5-mcp --dump-config; <DSH_BIN> --profile e5-mcp',
  },
  {
    source: join(probeRoot, 'e5-dump.stdout.raw.yml'),
    destination: 'e5-mcp/dump-config.yml',
    command: '<DSH_BIN> --profile e5-mcp --dump-config',
  },
  {
    source: join(probeRoot, 'e9-dump-default.stdout.raw.yml'),
    destination: 'e9/dump-default-config.yml',
    command: '<DSH_BIN> --profile e1-fresh --dump-default-config',
  },
  {
    source: join(probeRoot, 'e9-dump-config.stdout.raw.yml'),
    destination: 'e9/dump-config.yml',
    command: '<DSH_BIN> --profile e1-fresh --dump-config',
  },
  {
    source: resolve('docs/adr/raw/e9-version.raw.log'),
    destination: 'e9/version.txt',
    command: '<DSH_BIN> --version',
  },
];

const rawLogNames = [
  'e1-init.raw.log',
  'e2-add.raw.log',
  'e2-after-rename.raw.log',
  'e3-npm.raw.log',
  'e3-git.raw.log',
  'e3-tarball.raw.log',
  'e3-tarball-direct.raw.log',
  'e5-init.stderr.raw.log',
  'e5-boot.stderr.raw.log',
  'e9-missing-dump_default_config.stderr.raw.log',
  'e9-missing-dump_config.stderr.raw.log',
  'npm-install.raw.log',
];

function sanitize(input) {
  let output = input.replaceAll('\r\n', '\n');
  const pathReplacements = [
    [probeRoot, '<PROBE_ROOT>'],
    [probeRoot.replaceAll('\\', '/'), '<PROBE_ROOT>'],
    [workspaceRoot, '<WORKSPACE>'],
    [workspaceRoot.replaceAll('\\', '/'), '<WORKSPACE>'],
  ];
  for (const [value, replacement] of pathReplacements) {
    output = output.replaceAll(value, replacement);
  }
  for (const value of [process.env.USERNAME, process.env.COMPUTERNAME]) {
    if (value) output = output.replaceAll(value, '<REDACTED>');
  }
  output = output.replace(/(anonymous[-_]?user[-_]?id\s*[:=]\s*)[^\s,}\]]+/giu, '$1<REDACTED>');
  output = output.replace(/(Authorization:\s*)[^\r\n]+/giu, '$1<REDACTED>');
  return output;
}

async function readText(path) {
  const bytes = await readFile(path);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  return bytes.toString('utf8').replace(/^\uFEFF/u, '');
}

function assertSanitized(text, destination) {
  const forbiddenValues = [
    process.env.USERNAME,
    process.env.COMPUTERNAME,
    probeRoot,
    probeRoot.replaceAll('\\', '/'),
    workspaceRoot,
    workspaceRoot.replaceAll('\\', '/'),
  ].filter(Boolean);
  const foundLiteral = forbiddenValues.find((value) => text.includes(value));
  if (foundLiteral) throw new Error(`${destination}: 脱敏后仍含本机标识`);
  if (/\b(?:gh[pousr]_|npm_|sk-)[A-Za-z0-9_-]{8,}/u.test(text)) {
    throw new Error(`${destination}: 检测到疑似 token`);
  }
}

for (const fixture of fixtures) {
  const sourceStat = await stat(fixture.source);
  const destination = join(outputRoot, fixture.destination);
  const text = sanitize(await readText(fixture.source));
  assertSanitized(text, fixture.destination);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, text.endsWith('\n') ? text : `${text}\n`, 'utf8');

  const provenance = {
    command: fixture.command,
    dshVersion: '0.1.0-rc.6',
    pnpmVersion: '11.7.0',
    nodeVersion: process.version,
    os: `${process.platform} ${release()}`,
    generatedAt: sourceStat.mtime.toISOString(),
    upstreamCommit: '47f943859bef60e4160492346772ded9b24f765a',
    isolation: '所有 DSH 进程均显式使用临时 DSH_HOME。',
    sanitization: [
      '替换临时根目录与工作区绝对路径。',
      '替换用户名、机器名与 anonymous-user-id。',
      '扫描常见 token 前缀；未命中。',
    ],
  };
  const provenancePath = `${destination}.provenance.json`;
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
}

for (const name of rawLogNames) {
  const text = sanitize(await readText(join(probeRoot, name)));
  assertSanitized(text, name);
  const destination = resolve('docs/adr/raw', name.replace('.raw.log', '.sanitized.log'));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

for (const path of [
  resolve('docs/adr/raw/core-zero-side-effects-mutant-red.raw.log'),
  resolve('docs/adr/raw/core-zero-side-effects-restored-green.raw.log'),
  resolve('docs/adr/raw/e4-settings-concurrency.raw.log'),
  resolve('docs/adr/raw/e9-version.raw.log'),
]) {
  const original = await readText(path);
  const sanitized = sanitize(original);
  assertSanitized(sanitized, path);
  const normalized = sanitized.endsWith('\n') ? sanitized : `${sanitized}\n`;
  if (original !== normalized) await writeFile(path, normalized, 'utf8');
}

console.log(`fixtures_collected=${fixtures.length}`);
console.log(`logs_sanitized=${rawLogNames.length}`);
console.log(`fixtures_output=${outputRoot}`);
