import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const openedPaths = vi.hoisted<string[]>(() => []);
const syncedPaths = vi.hoisted<string[]>(() => []);

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      openedPaths.push(String(args[0]));
      try {
        if ((await original.lstat(args[0])).isDirectory()) {
          return {
            sync: async () => {
              syncedPaths.push(String(args[0]));
            },
            close: async () => undefined,
          } as Awaited<ReturnType<typeof original.open>>;
        }
      } catch {
        // New temporary files do not exist before exclusive open; use the real file handle below.
      }
      const handle = await original.open(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'sync')
            return async () => {
              syncedPaths.push(String(args[0]));
              return target.sync();
            };
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createNodeTransactionAdapter, runTransaction } from '../src/transaction.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-state-durability-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  openedPaths.splice(0);
  syncedPaths.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('transaction binary state durability', () => {
  it('fsyncs the exclusive state file and every newly-created state directory parent', async () => {
    const dshHome = await home();
    const bytes = Buffer.from('state');
    const digest = `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;
    const token = digest.slice('sha256-'.length);
    const path = join(dshHome, '.dshpack', 'store', token.slice(0, 2), digest);
    const result = await runTransaction(
      { adapter: createNodeTransactionAdapter(), dshHome, txid: 'state-parent-fsync' },
      async (transaction) => transaction.writeStateFile('store-block', path, bytes),
    );

    expect(result).toMatchObject({ exitCode: 0, status: 'committed' });
    expect(openedPaths).toContain(dirname(path));
    expect(syncedPaths).toEqual(
      expect.arrayContaining([
        path,
        dirname(path),
        join(dshHome, '.dshpack', 'store'),
        join(dshHome, '.dshpack'),
      ]),
    );
  });
});
