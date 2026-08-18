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

  it('gives up after a bounded number of transient failures', async () => {
    let attempts = 0;
    const waits: number[] = [];

    await expect(
      removeFixtureDirectory(
        'fixture-root',
        async () => {
          attempts += 1;
          // A runaway retry loop is a tight microtask chain that would starve the event
          // loop and hang the suite instead of timing out, so trip a distinguishable
          // permanent error rather than relying on the runner to interrupt it.
          if (attempts > 50) throw Object.assign(new Error('unbounded'), { code: 'EACCES' });
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
        async (milliseconds) => {
          waits.push(milliseconds);
        },
      ),
    ).rejects.toMatchObject({ code: 'EBUSY' });

    expect(attempts).toBe(5);
    expect(waits).toEqual([25, 50, 100, 200]);
  });

  it('does not swallow a permanent cleanup error', async () => {
    await expect(
      removeFixtureDirectory('fixture-root', async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });
});
