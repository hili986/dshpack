import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  nodeTransactionAdapter,
  runTransaction,
  type TransactionAdapter,
} from '../src/transaction.js';

describe('transaction settings candidate CAS', () => {
  it('rejects a candidate based on stale bytes without overwriting the external update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshpack-settings-cas-'));
    const dshHome = join(root, 'home');
    const settingsPath = join(dshHome, 'settings.yaml');
    const skillPath = join(dshHome, 'skills', 'review');
    const original = 'agent-presets:\n  default: original\n';
    const candidate = 'agent-presets:\n  default: transaction\n';
    const external = 'agent-presets:\n  default: external\n';
    await nodeTransactionAdapter.ensureDirectory(dshHome);
    await writeFile(settingsPath, original, 'utf8');

    let signalReadStarted = (): void => {};
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead = (): void => {};
    const mayRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const adapter: TransactionAdapter = {
      ...nodeTransactionAdapter,
      async readTextIfExists(path) {
        if (path === settingsPath) {
          signalReadStarted();
          await mayRead;
        }
        return nodeTransactionAdapter.readTextIfExists(path);
      },
    };

    try {
      const result = await runTransaction(
        { adapter, dshHome, txid: 'settings-stale-candidate' },
        async (transaction) => {
          await transaction.create('skill', skillPath, async () => {
            await writeFile(join(skillPath, 'SKILL.md'), '# installed\n', 'utf8');
          });
          const writing = transaction.writeSettings(settingsPath, original, candidate);
          await readStarted;
          await writeFile(settingsPath, external, 'utf8');
          releaseRead();
          await writing;
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 30 });
      expect(result.diagnostics[0]).toMatchObject({ code: 'E_TRANSACTION_SETTINGS_CHANGED' });
      expect(await readFile(settingsPath, 'utf8')).toBe(external);
      await expect(readFile(skillPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result.journal.actions).toMatchObject([
        { kind: 'create', phase: 'rolled-back', artifact: 'skill' },
      ]);
    } finally {
      releaseRead();
      await rm(root, { recursive: true, force: true });
    }
  });
});
