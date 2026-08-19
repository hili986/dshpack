import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.e2e.test.ts'],
    // Same reason the unit config is serial, and it applies here with more force: these files
    // drive real child processes through PATH shims and take exclusive locks on fixture homes.
    // Running the files in parallel does not make them independent — it makes them compete, and
    // a case that sits close to its budget turns into a random red that costs far more to
    // attribute than the wall-clock it saves. Measured: with the file parallel, adding one
    // process-spawning case to the suite made `install.e2e.test.ts` fail 2 runs out of 3 while
    // the same commit without that case passed 3 out of 3.
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
