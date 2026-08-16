import { readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [nodeModules, probeDirectory] = process.argv.slice(2);
if (!nodeModules || !probeDirectory) {
  throw new Error('usage: node scripts/probe-settings-lock.mjs <node_modules> <probe-dir>');
}

const resolveFromProbe = createRequire(join(nodeModules, '__dshpack_probe__.cjs')).resolve;
const importFromProbe = async (specifier) =>
  import(pathToFileURL(resolveFromProbe(specifier)).href);

// Import sequentially: schemastery's CommonJS bridge can observe a half-loaded
// cosmokit module when Node resolves these interdependent packages in parallel.
const { Context } = await importFromProbe('@deepseek-ai/cordis');
const { default: z } = await importFromProbe('@deepseek-ai/schemastery');
const { settingsNamespace } = await importFromProbe('@deepseek-ai/dsh-settings');
const { FileSettingsProvider } = await importFromProbe('@deepseek-ai/dsh-settings-file');

const alphaSchema = z.object({ value: z.number().default(0) });
const betaSchema = z.object({ value: z.number().default(0) });
const settingsPath = join(probeDirectory, 'settings.yaml');
const lockPath = `${settingsPath}.lock`;
const fibers = [];

async function boot() {
  const context = new Context();
  const fiber = context.plugin(FileSettingsProvider, { path: settingsPath, watch: false });
  await fiber;
  fibers.push(fiber);
  return context;
}

try {
  const first = await boot();
  const second = await boot();
  const alpha = first.settings.register(settingsNamespace('alpha'), alphaSchema);
  const beta = second.settings.register(settingsNamespace('beta'), betaSchema);
  const rounds = [1, 2, 3, 4, 5];

  await Promise.all([
    (async () => {
      for (const value of rounds) await alpha.update({ value });
    })(),
    (async () => {
      for (const value of rounds) await beta.update({ value });
    })(),
  ]);

  const third = await boot();
  const observedAlpha = third.settings.register(settingsNamespace('alpha'), alphaSchema).get();
  const observedBeta = third.settings.register(settingsNamespace('beta'), betaSchema).get();
  const concurrentText = await readFile(settingsPath, 'utf8');

  await writeFile(lockPath, 'holder\n', 'utf8');
  const waitStarted = Date.now();
  const release = setTimeout(() => void rm(lockPath, { force: true }), 120);
  await alpha.update({ value: 7 });
  clearTimeout(release);
  const waitedMs = Date.now() - waitStarted;

  await writeFile(lockPath, 'slow-holder\n', 'utf8');
  const oldTimestamp = (Date.now() - 60_000) / 1000;
  await utimes(lockPath, oldTimestamp, oldTimestamp);
  const beforeTimeout = await readFile(settingsPath, 'utf8');
  const timeoutStarted = Date.now();
  let timeoutMessage = '';
  try {
    await alpha.update({ value: 9 });
  } catch (error) {
    timeoutMessage = error instanceof Error ? error.message : String(error);
  }
  const timeoutMs = Date.now() - timeoutStarted;
  const afterTimeout = await readFile(settingsPath, 'utf8');
  const staleLock = await readFile(lockPath, 'utf8');

  const evidence = {
    concurrentNamespacesPreserved:
      concurrentText.includes('alpha:') && concurrentText.includes('beta:'),
    concurrentFinalValues: { alpha: observedAlpha.value, beta: observedBeta.value },
    busyLockWaitedMs: waitedMs,
    staleLockTimeoutMs: timeoutMs,
    staleLockMessageMatched: /timed out waiting for the writer lock/.test(timeoutMessage),
    staleLockPreserved: staleLock === 'slow-holder\n',
    documentUnchangedAfterTimeout: beforeTimeout === afterTimeout,
    lockSuffix: '.lock',
  };

  if (
    !evidence.concurrentNamespacesPreserved ||
    observedAlpha.value !== 5 ||
    observedBeta.value !== 5 ||
    waitedMs < 100 ||
    !evidence.staleLockMessageMatched ||
    !evidence.staleLockPreserved ||
    !evidence.documentUnchangedAfterTimeout
  ) {
    throw new Error(`settings lock contract failed: ${JSON.stringify(evidence)}`);
  }

  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  await rm(lockPath, { force: true });
}
