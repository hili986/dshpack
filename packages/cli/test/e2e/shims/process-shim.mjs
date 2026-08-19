import { spawn } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const recordPath = process.env.DSHPACK_SHIM_ARGV_LOG;

if (process.env.DSHPACK_SHIM_HOLD_STDIO === 'launcher') {
  const launcherPidPath = process.env.DSHPACK_SHIM_LAUNCHER_PID_PATH;
  const descendantPidPath = process.env.DSHPACK_SHIM_DESCENDANT_PID_PATH;
  if (launcherPidPath === undefined || descendantPidPath === undefined)
    throw new Error('timeout shim requires PID paths');
  await writeFile(launcherPidPath, `${process.pid}\n`, 'utf8');
  const descendant = spawn(process.execPath, [import.meta.filename], {
    env: { ...process.env, DSHPACK_SHIM_HOLD_STDIO: 'descendant' },
    stdio: 'inherit',
    windowsHide: true,
  });
  await writeFile(descendantPidPath, `${descendant.pid}\n`, 'utf8');
  await new Promise(() => undefined);
}

if (process.env.DSHPACK_SHIM_HOLD_STDIO === 'descendant') {
  process.on('SIGTERM', () => undefined);
  const holdMs = Number.parseInt(process.env.DSHPACK_SHIM_HOLD_STDIO_MS ?? '8000', 10);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  process.exit(0);
}

if (recordPath) {
  await appendFile(
    recordPath,
    `${JSON.stringify({ argv, cwd: process.cwd(), dshHome: process.env.DSH_HOME })}\n`,
    'utf8',
  );
}

const delay = Number.parseInt(process.env.DSHPACK_SHIM_DELAY_MS ?? '0', 10);
if (Number.isFinite(delay) && delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

process.stdout.write(process.env.DSHPACK_SHIM_STDOUT ?? '0.1.0-w9-shim\n');
process.stderr.write(process.env.DSHPACK_SHIM_STDERR ?? '');
process.exitCode = Number.parseInt(process.env.DSHPACK_SHIM_EXIT_CODE ?? '0', 10);
