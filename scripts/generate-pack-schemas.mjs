import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const truthScript = resolve(repository, 'scripts/pack-schema-truth.ts');
const schemaDirectory = resolve(repository, 'schemas');

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

const schemas = truth();
await mkdir(schemaDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(schemaDirectory, 'pack.schema.json'), render(schemas.pack), 'utf8'),
  writeFile(resolve(schemaDirectory, 'pack-lock.schema.json'), render(schemas.lock), 'utf8'),
]);
console.log('pack schemas generated from TypeBox truth source');
