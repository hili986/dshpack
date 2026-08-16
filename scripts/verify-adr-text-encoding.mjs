import { readdir, readFile } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
const defaultRoot = resolve(repository, 'docs/adr');
const root = resolve(process.argv[2] ?? defaultRoot);
const textExtensions = new Set(['.json', '.log', '.md', '.txt', '.yaml', '.yml']);

async function textEvidenceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await textEvidenceFiles(absolute)));
    if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase()))
      files.push(absolute);
  }
  return files;
}

const invalid = [];
for (const file of await textEvidenceFiles(root)) {
  const contents = await readFile(file);
  if (
    contents.length >= 2 &&
    ((contents[0] === 0xff && contents[1] === 0xfe) ||
      (contents[0] === 0xfe && contents[1] === 0xff))
  )
    invalid.push(relative(root, file).replaceAll('\\', '/'));
}

if (invalid.length > 0) {
  throw new Error(`UTF-16 BOM is forbidden in ADR text evidence: ${invalid.join(', ')}`);
}

console.log(`ADR text evidence verified UTF-8 no-BOM: ${relative(repository, root) || '.'}`);
