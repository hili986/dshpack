import { execFile } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bindDirectory,
  bindSecureRoot,
  linkedAncestor,
  MAX_SAFE_TEXT_BYTES,
  readDirectory,
  readText,
  revalidateDirectory,
} from '../src/list/safe-fs.js';

const roots: string[] = [];

async function temporary(prefix = 'safe-fs'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dshpack-${prefix}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('secure root ancestors', () => {
  it('names the linked ancestor, clears an ordinary chain, and fails closed when blind', async () => {
    const outer = await temporary('safe-linked-ancestor');
    const real = join(outer, 'real');
    await mkdir(join(real, 'home'), { recursive: true });
    await expect(linkedAncestor(join(real, 'home'))).resolves.toBeUndefined();

    const link = join(outer, 'link');
    await symlink(real, link, 'junction');
    await expect(linkedAncestor(join(link, 'home'))).resolves.toBe(link);

    // An ancestor we cannot inspect is one we cannot vouch for.
    const blind = join(real, 'home');
    await expect(
      linkedAncestor(blind, {
        beforeAncestorLstat: async (path) => {
          if (path === real) throw new Error('unreadable ancestor');
        },
      }),
    ).resolves.toBe(real);
  });

  it.runIf(process.platform === 'win32')(
    'accepts a root spelled as an 8.3 alias, which names the same directory through no link',
    async () => {
      const long = await temporary('safe-shortname');
      const quoted = long.replaceAll("'", "''");
      const short = await new Promise<string>((done, fail) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${quoted}').ShortPath`,
          ],
          (error, stdout) => (error === null ? done(stdout.trim()) : fail(error)),
        );
      });
      // Without this the test would pass while testing nothing: 8.3 generation can be off.
      expect(short).not.toBe(long);
      expect(await realpath(short)).toBe(long);

      // The old check compared this spelling against its realpath and called the
      // difference a symlink ancestor, refusing an ordinary home outright.
      await expect(bindSecureRoot(short)).resolves.toMatchObject({ ok: true });
      await expect(linkedAncestor(short)).resolves.toBeUndefined();
    },
  );
});

describe('secure directory bindings', () => {
  it('rejects an ancestor renamed behind a junction even when the bound inode is unchanged', async () => {
    const outer = await temporary('safe-ancestor-swap');
    const container = join(outer, 'container');
    const home = join(container, 'home');
    await mkdir(home, { recursive: true });
    const binding = await bindSecureRoot(home);
    if (!binding.ok) throw new Error('fixture root failed');
    const moved = join(outer, 'container-moved');
    await rename(container, moved);
    await symlink(moved, container, 'junction');

    await expect(revalidateDirectory(binding.value)).resolves.toMatchObject({
      ok: false,
      kind: 'security',
    });
  });

  it('detects an ancestor junction introduced after a child lstat but before its realpath', async () => {
    const home = await temporary('safe-child-ancestor-swap');
    const profiles = join(home, 'profiles');
    const profile = join(profiles, 'demo');
    await mkdir(profile, { recursive: true });
    const root = await bindSecureRoot(home);
    if (!root.ok) throw new Error('fixture root failed');
    const binding = await bindDirectory(root.value, ['profiles', 'demo']);
    if (!binding.ok) throw new Error('fixture binding failed');
    const moved = join(home, 'profiles-moved');
    let swapped = false;

    const result = await revalidateDirectory(binding.value, {
      afterDirectoryLstat: async (path) => {
        if (path !== profile || swapped) return;
        await rename(profiles, moved);
        await symlink(moved, profiles, 'junction');
        swapped = true;
      },
    });
    expect(swapped).toBe(true);
    expect(result).toMatchObject({ ok: false, kind: 'security' });
  });

  it('classifies relative, missing, file-shaped, and ancestor-linked roots', async () => {
    await expect(bindSecureRoot('relative')).resolves.toMatchObject({
      ok: false,
      kind: 'security',
    });
    const base = await temporary();
    await expect(bindSecureRoot(join(base, 'missing'))).resolves.toMatchObject({
      ok: false,
      kind: 'missing',
    });
    const file = join(base, 'file');
    await writeFile(file, 'x');
    await expect(bindSecureRoot(file)).resolves.toMatchObject({ ok: false, kind: 'security' });

    const target = await temporary('safe-target');
    await mkdir(join(target, 'child'));
    const link = join(base, 'linked');
    await symlink(target, link, 'junction');
    await expect(bindSecureRoot(join(link, 'child'))).resolves.toMatchObject({
      ok: false,
      kind: 'security',
    });
  });

  it('rejects lexical escape and directory replacement during or after binding', async () => {
    const root = await temporary();
    const child = join(root, 'child');
    await mkdir(child);
    const stable = await bindSecureRoot(root);
    expect(stable.ok).toBe(true);
    if (!stable.ok) return;
    await expect(bindDirectory(stable.value, ['..'])).resolves.toMatchObject({
      ok: false,
      kind: 'security',
    });

    let swapped = false;
    await expect(
      bindDirectory(stable.value, ['child'], {
        afterDirectoryLstat: async (path) => {
          if (path !== child || swapped) return;
          swapped = true;
          await rename(child, `${child}.old`);
          await mkdir(child);
        },
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'security' });

    const rebound = await bindDirectory(stable.value, ['child']);
    expect(rebound.ok).toBe(true);
    if (!rebound.ok) return;
    await rename(child, `${child}.new-old`);
    await mkdir(child);
    await expect(revalidateDirectory(rebound.value)).resolves.toMatchObject({
      ok: false,
      kind: 'security',
    });

    const vanishing = join(root, 'vanishing');
    await mkdir(vanishing);
    let removed = false;
    await expect(
      bindDirectory(stable.value, ['vanishing'], {
        afterDirectoryLstat: async (path) => {
          if (path !== vanishing || removed) return;
          removed = true;
          await rm(vanishing, { recursive: true });
        },
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'security' });
  });

  it('reads a directory and reports a file-shaped directory safely', async () => {
    const root = await temporary();
    await mkdir(join(root, 'items'));
    await writeFile(join(root, 'items', 'one'), '1');
    await writeFile(join(root, 'not-directory'), 'x');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');
    await expect(readDirectory(stable.value, ['items'])).resolves.toMatchObject({
      ok: true,
      value: [expect.objectContaining({ name: 'one' })],
    });
    await expect(readDirectory(stable.value, ['not-directory'])).resolves.toMatchObject({
      ok: false,
      kind: 'security',
    });
  });
});

describe('same-handle text reads', () => {
  it('classifies missing and non-file entries', async () => {
    const root = await temporary();
    await mkdir(join(root, 'directory'));
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');
    await expect(readText(stable.value, ['missing'])).resolves.toMatchObject({
      ok: false,
      kind: 'missing',
    });
    await expect(readText(stable.value, ['directory'])).resolves.toMatchObject({
      ok: false,
      kind: 'security',
    });
  });

  it.each(['afterFileLstat', 'afterFileOpen'] as const)(
    'detects pathname replacement at %s',
    async (hook) => {
      const root = await temporary();
      const path = join(root, 'value.txt');
      await writeFile(path, 'before');
      const stable = await bindSecureRoot(root);
      if (!stable.ok) throw new Error('fixture root failed');
      let swapped = false;
      const result = await readText(stable.value, ['value.txt'], {
        [hook]: async () => {
          if (swapped) return;
          swapped = true;
          await rename(path, `${path}.old`);
          await writeFile(path, 'replacement');
        },
      });
      expect(result).toMatchObject({ ok: false, kind: 'security' });
    },
  );

  it('detects a file changed into a directory before open', async () => {
    const root = await temporary();
    const path = join(root, 'value.txt');
    await writeFile(path, 'before');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');
    await expect(
      readText(stable.value, ['value.txt'], {
        afterFileLstat: async () => {
          await rename(path, `${path}.old`);
          await mkdir(path);
        },
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'security' });
  });

  it('detects a file removed before the no-follow handle opens', async () => {
    const root = await temporary();
    const path = join(root, 'value.txt');
    await writeFile(path, 'before');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');
    await expect(
      readText(stable.value, ['value.txt'], {
        afterFileLstat: async () => rm(path),
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'security' });
  });

  it('detects in-place modification and maps unexpected read failures', async () => {
    const root = await temporary();
    const path = join(root, 'value.txt');
    await writeFile(path, 'before');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');
    await expect(
      readText(stable.value, ['value.txt'], {
        afterFileRead: async () => appendFile(path, '-changed'),
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'security' });
    await expect(
      readText(stable.value, ['value.txt'], {
        afterFileOpen: async () => Promise.reject(new Error('injected IO')),
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'io' });
  });

  it('bounds a file that grows while the same handle is being read', async () => {
    const root = await temporary();
    const path = join(root, 'growing.txt');
    await writeFile(path, 'start');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');
    let grown = false;
    const result = await readText(stable.value, ['growing.txt'], {
      afterFileChunk: async () => {
        if (grown) return;
        grown = true;
        await appendFile(path, Buffer.alloc(MAX_SAFE_TEXT_BYTES + 1, 0x61));
      },
    });
    expect(grown).toBe(true);
    expect(result).toMatchObject({ ok: false, kind: 'io' });
  });

  it('detects a pathname removed after the handle read', async () => {
    const root = await temporary();
    const removed = join(root, 'removed.txt');
    await writeFile(removed, 'before');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');
    await expect(
      readText(stable.value, ['removed.txt'], {
        afterFileRead: async () => rename(removed, `${removed}.old`),
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'security' });
  });
});
