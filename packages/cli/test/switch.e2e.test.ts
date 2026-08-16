import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { switchProfile } from '../src/switch/engine.js';

const fixtureDirectory = fileURLToPath(new URL('./e2e/shims/', import.meta.url));
const roots: string[] = [];

async function dshHome(): Promise<{ home: string; log: string; shim: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-switch-e2e-'));
  roots.push(root);
  const home = join(root, 'DSH HOME 空格');
  const profile = join(home, 'profiles', 'demo');
  const shim = join(root, 'PATH first shim');
  const log = join(root, 'argv.jsonl');
  await mkdir(profile, { recursive: true });
  await mkdir(shim);
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-demo',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }),
    'utf8',
  );
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
  await writeFile(
    join(profile, 'pnpm-workspace.yaml'),
    "packages: ['.']\nnodeLinker: hoisted\nautoInstallPeers: false\n",
  );
  await copyFile(join(fixtureDirectory, 'process-shim.mjs'), join(shim, 'process-shim.mjs'));
  if (process.platform === 'win32')
    await copyFile(join(fixtureDirectory, 'dsh.cmd'), join(shim, 'dsh.cmd'));
  else {
    await copyFile(join(fixtureDirectory, 'dsh'), join(shim, 'dsh'));
    await chmod(join(shim, 'dsh'), 0o755);
  }
  return { home, log, shim };
}

afterAll(async () => {
  await Promise.all(roots.map((path) => rm(path, { force: true, recursive: true })));
});

describe.sequential('conservative switch with a PATH-first dsh shim', () => {
  it('does not spawn or mutate the session by default, then --run forwards exact argv', async () => {
    const fixture = await dshHome();
    const previous = {
      node: process.env.DSHPACK_NODE_EXE,
      log: process.env.DSHPACK_SHIM_ARGV_LOG,
      path: process.env.PATH,
    };
    process.env.DSHPACK_NODE_EXE = process.execPath;
    process.env.DSHPACK_SHIM_ARGV_LOG = fixture.log;
    process.env.PATH = [fixture.shim, dirname(process.execPath)].join(delimiter);
    try {
      const conservative = await switchProfile({ dshHome: fixture.home, profile: 'demo' });
      expect(conservative).toMatchObject({ exitCode: 0, metadata: { ran: false } });
      await expect(readFile(fixture.log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const running = await switchProfile({ dshHome: fixture.home, profile: 'demo', run: true });
      expect(running).toMatchObject({ exitCode: 0, metadata: { ran: true } });
      const record = JSON.parse((await readFile(fixture.log, 'utf8')).trim()) as {
        argv: string[];
        cwd: string;
        dshHome: string;
      };
      expect(record).toEqual({
        argv: ['--profile', 'demo'],
        cwd: join(fixture.home, 'profiles', 'demo'),
        dshHome: fixture.home,
      });
    } finally {
      if (previous.node === undefined) delete process.env.DSHPACK_NODE_EXE;
      else process.env.DSHPACK_NODE_EXE = previous.node;
      if (previous.log === undefined) delete process.env.DSHPACK_SHIM_ARGV_LOG;
      else process.env.DSHPACK_SHIM_ARGV_LOG = previous.log;
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
    }
  });
});
