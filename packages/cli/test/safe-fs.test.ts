import { execFile } from 'node:child_process';
import {
  appendFile,
  link,
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
  readBytes,
  readDirectory,
  readText,
  revalidateDirectory,
  sameIdentity,
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
  it('treats birthtime as part of the stable asset identity triple', () => {
    const stable = { dev: 7n, ino: 9n, birthtimeNs: 11n };

    expect(sameIdentity(stable, { ...stable })).toBe(true);
    expect(sameIdentity(stable, { ...stable, birthtimeNs: 12n })).toBe(false);
  });

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
      // `cmd`'s %~sI expands to the 8.3 spelling in about 45ms. The COM route through
      // powershell.exe returns the same string but pays for a shell start plus object
      // activation, which on a cold CI runner overran the 5s default and failed this
      // test for a reason that had nothing to do with what it checks.
      // windowsVerbatimArguments keeps Node from re-quoting the path into the value.
      const short = await new Promise<string>((done, fail) => {
        execFile(
          'cmd.exe',
          ['/d', '/c', `for %I in ("${long}") do @echo %~sI`],
          { windowsVerbatimArguments: true },
          (error, stdout) => (error === null ? done(stdout.trim()) : fail(error)),
        );
      });
      // The precondition is that this spelling really is an alias — not merely that it
      // differs from the one we created the directory with. Without it the test would
      // pass while testing nothing, since 8.3 generation can be turned off machine-wide.
      // Stated against realpath so it holds even when TEMP is itself an aliased path.
      expect(short).not.toBe(await realpath(short));
      expect(await realpath(short)).toBe(await realpath(long));

      // The old check compared this spelling against its realpath and called the
      // difference a symlink ancestor, refusing an ordinary home outright.
      await expect(bindSecureRoot(short)).resolves.toMatchObject({ ok: true });
      await expect(linkedAncestor(short)).resolves.toBeUndefined();
    },
    // Spawning a process is the one slow step here; leave headroom so a busy runner
    // cannot turn a passing assertion into a timeout.
    30_000,
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

  it('rejects a same-inode directory whose entry set changes after enumeration', async () => {
    const root = await temporary('safe-directory-entry-set');
    const items = join(root, 'items');
    await mkdir(items);
    await writeFile(join(items, 'before'), 'before');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');
    let mutated = false;

    const result = await readDirectory(stable.value, ['items'], {
      afterDirectoryRead: async (path) => {
        if (path !== items || mutated) return;
        mutated = true;
        await writeFile(join(items, 'appeared-after-enumeration'), 'after');
      },
    });

    expect(mutated).toBe(true);
    expect(result).toMatchObject({ ok: false, kind: 'changed' });
  });
});

describe('same-handle text reads', () => {
  it('returns exact binary bytes, rejects invalid UTF-8 text, and honors a caller-specific bound', async () => {
    const root = await temporary();
    const binary = join(root, 'binary.bin');
    const text = join(root, 'text.txt');
    await writeFile(binary, Buffer.from([0, 255, 1]));
    await writeFile(text, 'four');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');

    const bytes = await readBytes(stable.value, ['binary.bin']);
    expect(bytes).toMatchObject({ ok: true, value: { bytes: Buffer.from([0, 255, 1]) } });
    if (!bytes.ok) throw new Error('binary fixture did not read');
    expect(bytes.value.identity.split(':')).toHaveLength(3);
    await expect(readText(stable.value, ['binary.bin'])).resolves.toMatchObject({
      ok: false,
      kind: 'security',
    });
    await expect(readBytes(stable.value, ['text.txt'], {}, 3)).resolves.toMatchObject({
      ok: false,
      kind: 'limit',
    });
  });

  it('opens with O_NONBLOCK and rejects a FIFO-like handle swapped after lstat', async () => {
    const root = await temporary();
    const path = join(root, 'state');
    await writeFile(path, 'regular before the open window');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');
    let receivedFlags: number | undefined;
    let reads = 0;
    const testNonBlockingFlag = 0x40000000;

    const result = await readBytes(stable.value, ['state'], {
      nonBlockingFlag: testNonBlockingFlag,
      openFile: async (_path: string, flags: number) => {
        receivedFlags = flags;
        return {
          stat: async () => ({ isFile: () => false, nlink: 1n }),
          read: async () => {
            reads += 1;
            return { bytesRead: 0 };
          },
          close: async () => undefined,
        } as never;
      },
    } as never);

    expect(receivedFlags).toBeDefined();
    expect((receivedFlags as number) & testNonBlockingFlag).not.toBe(0);
    expect(reads).toBe(0);
    expect(result).toMatchObject({ ok: false, kind: 'security' });
  });

  it('rejects an oversized state file before attempting an open', async () => {
    const root = await temporary('safe-oversized-before-open');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root binding failed');
    await writeFile(join(root, 'oversized'), Buffer.alloc(129));
    let opens = 0;

    const result = await readBytes(
      stable.value,
      ['oversized'],
      {
        openFile: async () => {
          opens += 1;
          throw new Error('oversized input must not be opened');
        },
      },
      128,
    );

    expect(opens).toBe(0);
    expect(result).toMatchObject({ ok: false, kind: 'limit' });
  });

  it('rejects an unsafe parent and a final-path replacement after the read snapshot', async () => {
    const root = await temporary();
    const parent = join(root, 'not-a-directory');
    const path = join(root, 'value.txt');
    await writeFile(parent, 'file');
    await writeFile(path, 'before');
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');

    await expect(readBytes(stable.value, ['not-a-directory', 'child'])).resolves.toMatchObject({
      ok: false,
      kind: 'security',
    });
    await expect(
      readBytes(stable.value, ['value.txt'], {
        afterFileSnapshot: async () => {
          await rename(path, `${path}.old`);
          await writeFile(path, 'replacement');
        },
      }),
    ).resolves.toMatchObject({ ok: false, kind: 'security' });
  });

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

  it('refuses a hardlinked state candidate before opening it', async () => {
    const root = await temporary();
    const source = join(root, 'source.txt');
    const linked = join(root, 'linked.txt');
    await writeFile(source, 'shared bytes');
    await link(source, linked);
    const stable = await bindSecureRoot(root);
    if (!stable.ok) throw new Error('fixture root failed');

    await expect(readText(stable.value, ['linked.txt'])).resolves.toMatchObject({
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
    expect(result).toMatchObject({ ok: false, kind: 'limit' });
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
