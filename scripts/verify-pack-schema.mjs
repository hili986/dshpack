import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const truthScript = resolve(repository, 'scripts/pack-schema-truth.ts');

function truth() {
  const output = execFileSync(process.execPath, [truthScript], {
    cwd: repository,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const expected = truth();
const files = [
  ['schemas/pack.schema.json', expected.pack],
  ['schemas/pack-lock.schema.json', expected.lock],
];
const drifted = [];
for (const [relative, schema] of files) {
  const actual = await readFile(resolve(repository, relative), 'utf8').catch(() => undefined);
  if (actual !== render(schema)) drifted.push(relative);
}
if (drifted.length > 0) {
  throw new Error(`pack schema drift: ${drifted.join(', ')}; run pnpm schemas:generate`);
}
console.log('pack schemas verified against TypeBox truth source');
