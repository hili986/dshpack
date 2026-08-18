import { rm } from 'node:fs/promises';

const TRANSIENT_REMOVE_ERRORS = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const MAX_REMOVE_ATTEMPTS = 5;

type RemoveDirectory = (path: string) => Promise<void>;
type Wait = (milliseconds: number) => Promise<void>;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Remove only a fixture root, surfacing permanent cleanup errors to the test runner. */
export async function removeFixtureDirectory(
  path: string,
  remove: RemoveDirectory = async (directory) => {
    await rm(directory, { recursive: true, maxRetries: 0 });
  },
  sleep: Wait = wait,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove(path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return;
      if (
        code === undefined ||
        !TRANSIENT_REMOVE_ERRORS.has(code) ||
        attempt >= MAX_REMOVE_ATTEMPTS
      )
        throw error;
      await sleep(25 * 2 ** (attempt - 1));
    }
  }
}
