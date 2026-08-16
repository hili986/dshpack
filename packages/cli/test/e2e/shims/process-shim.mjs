import { appendFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const recordPath = process.env.DSHPACK_SHIM_ARGV_LOG;

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
