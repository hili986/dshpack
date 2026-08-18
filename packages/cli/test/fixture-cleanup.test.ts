import { describe, expect, it } from 'vitest';

import { removeFixtureDirectory } from './fixture-cleanup.js';

describe('fixture directory cleanup', () => {
  it('retries transient Windows directory locks with a bounded backoff', async () => {
    let attempts = 0;
    const waits: number[] = [];
    await removeFixtureDirectory(
      'fixture-root',
      async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      },
      async (milliseconds) => {
        waits.push(milliseconds);
      },
    );

    expect(attempts).toBe(3);
    expect(waits.length).toBe(2);
    expect(waits.every((milliseconds) => milliseconds > 0)).toBe(true);
  });

  it('does not swallow a permanent cleanup error', async () => {
    await expect(
      removeFixtureDirectory('fixture-root', async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });
});
