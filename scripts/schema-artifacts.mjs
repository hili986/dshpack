import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const truthScript = resolve(repository, 'scripts/pack-schema-truth.ts');
const biome = resolve(repository, 'node_modules', '@biomejs', 'biome', 'bin', 'biome');

export const schemaArtifacts = [
  {
    name: 'pack',
    published: 'packages/core/schemas/pack.schema.json',
    rootMirror: 'schemas/pack.schema.json',
    truthKey: 'pack',
  },
  {
    name: 'pack-lock',
    published: 'packages/core/schemas/pack-lock.schema.json',
    rootMirror: 'schemas/pack-lock.schema.json',
    truthKey: 'lock',
  },
];

function truth() {
  const output = execFileSync(process.execPath, [truthScript], {
    cwd: repository,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function render(relative, value) {
  return Buffer.from(
    execFileSync(process.execPath, [biome, 'format', '--stdin-file-path', relative], {
      cwd: repository,
      encoding: 'utf8',
      input: `${JSON.stringify(value, null, 2)}\n`,
    }),
    'utf8',
  );
}

/** Produce the canonical bytes from the TypeBox source, then mirror them for root consumers. */
export function expectedSchemaArtifacts() {
  const source = truth();
  return schemaArtifacts.flatMap(({ name, published, rootMirror, truthKey }) => {
    const contents = render(published, source[truthKey]);
    return [
      { contents, name, relative: published },
      { contents, name, relative: rootMirror },
    ];
  });
}
