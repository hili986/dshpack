import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';

import { x as extractTarball } from 'tar';

import { expectedSchemaArtifacts, repository } from './schema-artifacts.mjs';

const placeholderRepositoryUrl = 'git+https://github.com/<owner>/<repo>.git';
const repositoryUrl =
  /^git\+https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9.-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.git$/u;
const fixtureCredentialMarkers = ['AKIAIOSFODNN7EXAMPLE', 'sk-TESTONLY-', 'ghp_TESTONLY_'];

const packages = [
  { directory: 'packages/core', name: '@dshpack/core' },
  { directory: 'packages/cli', name: 'dshpack' },
];

function pnpmInvocation() {
  if (process.platform !== 'win32') return { args: [], command: 'pnpm' };
  const wrappers = (process.env.PATH ?? '')
    .split(delimiter)
    .map((directory) => join(directory, 'pnpm.cmd'))
    .filter((candidate) => existsSync(candidate));
  for (const wrapper of wrappers) {
    const cli = [
      join(dirname(wrapper), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      join(dirname(wrapper), '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    ].find((candidate) => existsSync(candidate));
    if (cli !== undefined) return { args: [cli], command: process.execPath };
  }
  throw new Error('pnpm CLI entrypoint was not found beside any pnpm.cmd on PATH');
}

function requireMetadata(manifest, packageDirectory) {
  const missing = [
    ['license', manifest.license],
    ['author', manifest.author],
    ['repository.type', manifest.repository?.type],
    ['repository.url', manifest.repository?.url],
    ['repository.directory', manifest.repository?.directory],
    ['homepage', manifest.homepage],
    ['bugs', manifest.bugs],
    ['keywords', manifest.keywords],
  ]
    .filter(([, value]) => value === undefined || value === '' || value === null)
    .map(([field]) => field);
  if (missing.length > 0) {
    throw new Error(`${packageDirectory} missing publish metadata: ${missing.join(', ')}`);
  }
  if (manifest.repository.type !== 'git') {
    throw new Error(`${packageDirectory} repository.type must be git`);
  }
  if (manifest.repository.directory !== packageDirectory) {
    throw new Error(`${packageDirectory} repository.directory must equal ${packageDirectory}`);
  }
  if (
    manifest.repository.url !== placeholderRepositoryUrl &&
    !repositoryUrl.test(manifest.repository.url)
  ) {
    throw new Error(`${packageDirectory} repository.url has an invalid git+https GitHub shape`);
  }
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
    throw new Error(`${packageDirectory} keywords must be a non-empty array`);
  }
}

async function filesUnder(root) {
  const output = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      if (entry.isFile())
        output.push({ absolute, relative: relative(root, absolute).replaceAll('\\', '/') });
    }
  };
  await visit(root);
  return output;
}

function forbiddenPath(path) {
  const segments = path.toLowerCase().split('/');
  const base = segments.at(-1) ?? '';
  return (
    base === '.env' ||
    base.startsWith('.env.') ||
    segments.some((segment) => ['fixture', 'fixtures', 'test', 'tests'].includes(segment)) ||
    base.includes('.test.') ||
    base.includes('.spec.')
  );
}

async function assertForbiddenContentAbsent(files, packageName) {
  const forbidden = files.filter(({ relative: path }) => forbiddenPath(path));
  if (forbidden.length > 0) {
    throw new Error(
      `${packageName} tarball contains forbidden path(s): ${forbidden.map(({ relative }) => relative).join(', ')}`,
    );
  }
  for (const file of files) {
    const contents = await readFile(file.absolute);
    if (fixtureCredentialMarkers.some((marker) => contents.includes(Buffer.from(marker)))) {
      throw new Error(
        `${packageName} tarball contains a fixture credential marker in ${file.relative}`,
      );
    }
  }
}

async function pack(packageName, destination) {
  const args = ['--filter', packageName, 'pack', '--pack-destination', destination];
  const options = { cwd: repository, encoding: 'utf8' };
  const invocation = pnpmInvocation();
  execFileSync(invocation.command, [...invocation.args, ...args], options);
  const archives = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz'));
  if (archives.length !== 1) {
    throw new Error(`${packageName} pack produced ${archives.length} tarballs instead of one`);
  }
  return join(destination, archives[0]);
}

async function assertCoreSchemas(extractionRoot) {
  const expected = expectedSchemaArtifacts().filter(({ relative: path }) =>
    path.startsWith('packages/core/schemas/'),
  );
  for (const artifact of expected) {
    const tarPath = join(extractionRoot, 'package', 'schemas', basename(artifact.relative));
    const actual = await readFile(tarPath).catch(() => undefined);
    if (actual === undefined) {
      throw new Error(`missing required schema: package/schemas/${basename(artifact.relative)}`);
    }
    if (!actual.equals(artifact.contents)) {
      throw new Error(
        `schema differs from TypeBox truth: package/schemas/${basename(artifact.relative)}`,
      );
    }
  }
}

export async function verifyReleasePack() {
  for (const { directory } of packages) {
    const manifest = JSON.parse(
      await readFile(resolve(repository, directory, 'package.json'), 'utf8'),
    );
    requireMetadata(manifest, directory);
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dshpack-release-pack-'));
  try {
    for (const packageToVerify of packages) {
      const packageRoot = join(temporaryRoot, packageToVerify.name.replaceAll('/', '-'));
      const destination = join(packageRoot, 'tarballs');
      const extractionRoot = join(packageRoot, 'extracted');
      await mkdir(destination, { recursive: true });
      const archive = await pack(packageToVerify.name, destination);
      await mkdir(extractionRoot, { recursive: true });
      await extractTarball({ cwd: extractionRoot, file: archive, strict: true });
      const files = await filesUnder(extractionRoot);
      await assertForbiddenContentAbsent(files, packageToVerify.name);
      if (packageToVerify.name === '@dshpack/core') await assertCoreSchemas(extractionRoot);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  console.log(
    'release tarballs verified: required schemas match TypeBox truth; forbidden files absent',
  );
  console.log(
    `repository URL placeholder remains explicit: ${placeholderRepositoryUrl}; provenance publish is blocked until user selects the repository.`,
  );
}

await verifyReleasePack();
