import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { Diagnostic } from '@dshpack/core';
import { describe, expect, it } from 'vitest';

import { nodeTransactionAdapter, runTransaction, TransactionFailure } from '../src/transaction.js';

const injectedFailure: Diagnostic = {
  code: 'E_TEST_STEP',
  severity: 'error',
  message: 'injected post-settings failure',
  evidence: 'local',
};

describe('node transaction adapter', () => {
  it('persists a real journal and restores artifacts and settings from backup', async () => {
    const tempParent = resolve(tmpdir());
    const tempRoot = await mkdtemp(join(tempParent, 'dshpack-transaction-'));
    if (dirname(tempRoot) !== tempParent) throw new Error(`unsafe temporary path: ${tempRoot}`);
    try {
      const dshHome = join(tempRoot, 'DSH home');
      const profilePath = join(dshHome, 'profiles', 'research profile');
      const settingsPath = join(dshHome, 'settings.yaml');
      await mkdir(dshHome, { recursive: true });
      await writeFile(settingsPath, '# original\nagent-presets: {}\n', 'utf8');

      const result = await runTransaction(
        { adapter: nodeTransactionAdapter, dshHome, txid: 'node-smoke' },
        async (transaction) => {
          await transaction.create('profile', profilePath, async () => {
            await writeFile(join(profilePath, 'package.json'), '{"private":true}\n', 'utf8');
          });
          await transaction.writeSettings(
            settingsPath,
            '# original\nagent-presets: {}\n',
            'agent-presets:\n  default: research\n',
          );
          throw new TransactionFailure(23, [injectedFailure]);
        },
      );

      expect(result).toMatchObject({ ok: false, status: 'rolled-back', exitCode: 23 });
      expect(await readFile(settingsPath, 'utf8')).toBe('# original\nagent-presets: {}\n');
      expect(JSON.parse(await readFile(result.journalPath, 'utf8'))).toMatchObject({
        state: 'rolled-back',
        actions: [{ kind: 'create' }, { kind: 'settings-write' }],
      });
      const createAction = result.journal.actions[0];
      expect(createAction?.kind).toBe('create');
      if (createAction?.kind === 'create') {
        expect(await readFile(join(createAction.new.rollbackPath, 'package.json'), 'utf8')).toBe(
          '{"private":true}\n',
        );
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
