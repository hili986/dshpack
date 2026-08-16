import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expectedSchemaArtifacts, repository } from './schema-artifacts.mjs';

const drifted = [];
for (const { contents, relative } of expectedSchemaArtifacts()) {
  const actual = await readFile(resolve(repository, relative)).catch(() => undefined);
  if (actual === undefined || !actual.equals(contents)) {
    drifted.push(relative);
  }
}
if (drifted.length > 0) {
  throw new Error(`pack schema drift: ${drifted.join(', ')}; run pnpm schemas:generate`);
}
console.log('pack schemas verified byte-for-byte against TypeBox truth source');
