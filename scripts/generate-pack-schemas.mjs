import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { expectedSchemaArtifacts, repository } from './schema-artifacts.mjs';

await Promise.all(
  expectedSchemaArtifacts().map(async ({ contents, relative }) => {
    const target = resolve(repository, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }),
);
console.log(
  'pack schemas generated from TypeBox truth source (core publish artifacts + root mirrors)',
);
