import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';

if (process.env.DSH_REAL_SMOKE !== '1') {
  console.log('real-dsh smoke: skipped (set DSH_REAL_SMOKE=1 to opt in)');
  process.exit(0);
}

const dshPackage = '@deepseek-ai/dsh@0.1.0-rc.6';
const probeRoot = await mkdtemp(join(tmpdir(), 'dshpack-real-smoke-'));
const temporaryPrefix = `${tmpdir()}${sep}`;
if (!probeRoot.startsWith(temporaryPrefix)) {
  throw new Error('refusing to use a probe directory outside the system temporary directory');
}
const dshHome = join(probeRoot, 'dsh-home');
await mkdir(dshHome);
let dshEntry = process.env.DSH_SMOKE_ENTRY;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: dshHome },
    shell: false,
    timeout: 600_000,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr.trim() || '<no stderr>'}`,
    );
  }
  return result.stdout;
}

async function prepareWindowsEntry() {
  if (dshEntry) return;
  const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await access(npmCli);
  const prefix = join(probeRoot, 'dsh-cli');
  run(process.execPath, [
    npmCli,
    'install',
    '--prefix',
    prefix,
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    dshPackage,
  ]);
  dshEntry = join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
}

function runDsh(args) {
  if (dshEntry) return run(process.execPath, [dshEntry, ...args]);
  const npxArgs = ['--yes', dshPackage, ...args];
  return run('npx', npxArgs);
}

try {
  if (dshEntry && !isAbsolute(dshEntry)) {
    throw new Error('DSH_SMOKE_ENTRY must be an absolute path');
  }
  if (process.platform === 'win32') await prepareWindowsEntry();
  if (dshEntry) await access(dshEntry);

  const version = runDsh(['--version']).trim();
  if (version !== '0.1.0-rc.6') throw new Error(`unexpected dsh version: ${version}`);

  const defaultDump = runDsh(['--profile', 'web', '--dump-default-config']);
  if (
    !defaultDump.startsWith('# == @deepseek-ai/dsh-base\n') ||
    !defaultDump.includes('- id: timer')
  ) {
    throw new Error('default config dump did not have the proven YAML composition shape');
  }

  console.log(`real-dsh version: ${version}`);
  console.log(`real-dsh dump-default-config lines: ${defaultDump.trimEnd().split('\n').length}`);
  console.log('real-dsh isolation: temporary DSH_HOME');
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}
