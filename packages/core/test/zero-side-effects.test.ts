import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(import.meta.dirname, '../src');

const forbiddenNodeImports = [
  'fs',
  'node:fs',
  'child_process',
  'node:child_process',
  'http',
  'node:http',
  'https',
  'node:https',
  'http2',
  'node:http2',
  'net',
  'node:net',
  'tls',
  'node:tls',
  'dgram',
  'node:dgram',
  'dns',
  'node:dns',
] as const;

const forbiddenNetworkPackages = [
  'axios',
  'got',
  'ky',
  'node-fetch',
  'superagent',
  'undici',
] as const;

interface Violation {
  file: string;
  kind: 'escape' | 'import';
  rule: string;
}

function isPackageOrSubpath(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function isForbidden(specifier: string): boolean {
  return [...forbiddenNodeImports, ...forbiddenNetworkPackages].some((packageName) =>
    isPackageOrSubpath(specifier, packageName),
  );
}

function importedSpecifiers(source: string): readonly string[] {
  const specifiers = new Set<string>();

  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gu,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\bimport\s+\w+\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

const forbiddenEscapeRules = [
  { rule: 'process.getBuiltinModule', pattern: /\bprocess\.getBuiltinModule\s*\(/u },
  { rule: 'process.binding', pattern: /\bprocess\.binding\s*\(/u },
  { rule: 'fetch', pattern: /(?<![\w$.])fetch\s*\(/u },
  { rule: 'new WebSocket', pattern: /\bnew\s+WebSocket\s*\(/u },
  {
    rule: 'dynamic import expression',
    pattern: /\bimport\s*\(\s*(?!['"](?:\\.|[^'"])*['"]\s*\))/u,
  },
] as const;

function forbiddenEscapeRoutes(source: string): readonly string[] {
  return forbiddenEscapeRules.filter(({ pattern }) => pattern.test(source)).map(({ rule }) => rule);
}

async function typescriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return typescriptFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    }),
  );
  return files.flat();
}

async function findForbiddenImports(root: string): Promise<readonly Violation[]> {
  const violations: Violation[] = [];

  for (const file of await typescriptFiles(root)) {
    const source = await readFile(file, 'utf8');
    for (const specifier of importedSpecifiers(source)) {
      if (isForbidden(specifier)) {
        violations.push({
          file: path.relative(root, file).replaceAll(path.sep, '/'),
          kind: 'import',
          rule: specifier,
        });
      }
    }
    for (const rule of forbiddenEscapeRoutes(source)) {
      violations.push({
        file: path.relative(root, file).replaceAll(path.sep, '/'),
        kind: 'escape',
        rule,
      });
    }
  }

  return violations.sort((left, right) =>
    `${left.file}:${left.kind}:${left.rule}`.localeCompare(
      `${right.file}:${right.kind}:${right.rule}`,
    ),
  );
}

describe('core source zero-side-effect boundary', () => {
  it('contains no filesystem, subprocess, or network imports', async () => {
    await expect(findForbiddenImports(sourceRoot)).resolves.toEqual([]);
  });

  it.each([
    'node:fs/promises',
    'fs/promises',
    'node:child_process',
    'child_process',
    'undici',
    'axios',
  ])('detects a temporary %s import mutant', async (specifier) => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dshpack-core-import-mutant-'));
    const temporarySourceRoot = path.join(temporaryRoot, 'src');

    try {
      await mkdir(temporarySourceRoot);
      await writeFile(
        path.join(temporarySourceRoot, 'mutant.ts'),
        `import ${JSON.stringify(specifier)};\nexport {};\n`,
        'utf8',
      );

      await expect(findForbiddenImports(temporarySourceRoot)).resolves.toEqual([
        { file: 'mutant.ts', kind: 'import', rule: specifier },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'process.getBuiltinModule',
      "process.getBuiltinModule('node:fs');\nexport {};\n",
      'process.getBuiltinModule',
    ],
    ['process.binding', "process.binding('fs');\nexport {};\n", 'process.binding'],
    ['bare fetch', "fetch('https://example.test');\nexport {};\n", 'fetch'],
    [
      'WebSocket construction',
      "new WebSocket('wss://example.test');\nexport {};\n",
      'new WebSocket',
    ],
    [
      'dynamic import expression',
      "const specifier = 'node:fs';\nawait import(specifier);\nexport {};\n",
      'dynamic import expression',
    ],
  ])('detects a temporary %s import-free escape mutant', async (_name, source, rule) => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dshpack-core-escape-mutant-'));
    const temporarySourceRoot = path.join(temporaryRoot, 'src');

    try {
      await mkdir(temporarySourceRoot);
      await writeFile(path.join(temporarySourceRoot, 'mutant.ts'), source, 'utf8');

      await expect(findForbiddenImports(temporarySourceRoot)).resolves.toEqual([
        { file: 'mutant.ts', kind: 'escape', rule },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('detects the same import-free escape in every source file', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'dshpack-core-escape-multi-mutant-'));
    const temporarySourceRoot = path.join(temporaryRoot, 'src');

    try {
      await mkdir(temporarySourceRoot);
      await writeFile(
        path.join(temporarySourceRoot, 'first.ts'),
        "fetch('https://first.example.test');\nexport {};\n",
        'utf8',
      );
      await writeFile(
        path.join(temporarySourceRoot, 'second.ts'),
        "fetch('https://second.example.test');\nexport {};\n",
        'utf8',
      );

      await expect(findForbiddenImports(temporarySourceRoot)).resolves.toEqual([
        { file: 'first.ts', kind: 'escape', rule: 'fetch' },
        { file: 'second.ts', kind: 'escape', rule: 'fetch' },
      ]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
