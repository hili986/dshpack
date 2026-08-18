import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { writeFileAtomic } from '../src/adapters/fs.js';
import {
  type SettingsClock,
  withSettingsFileLock,
  YamlSettingsAdapter,
} from '../src/adapters/settings.js';

const MAX_LOCK_TIMEOUT_ATTEMPTS = 8;

type SettingsUpdateResult = Awaited<ReturnType<YamlSettingsAdapter['updateAgentPresets']>>;

async function withScratch(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dshpack-settings-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class FakeClock implements SettingsClock {
  readonly sleeps: number[] = [];
  private current = 0;

  now(): number {
    return this.current;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.current += milliseconds;
  }
}

async function retrySettingsLockTimeout(
  label: string,
  update: () => Promise<SettingsUpdateResult>,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_LOCK_TIMEOUT_ATTEMPTS; attempt += 1) {
    const result = await update();
    if (result.ok) {
      expect(result).toEqual({ ok: true, value: undefined, diagnostics: [] });
      return;
    }
    if (
      result.diagnostics.length === 1 &&
      result.diagnostics[0]?.code === 'E_SETTINGS_LOCK_TIMEOUT'
    )
      continue;
    expect(result).toEqual({ ok: true, value: undefined, diagnostics: [] });
    return;
  }
  throw new Error(
    `${label} exceeded ${String(MAX_LOCK_TIMEOUT_ATTEMPTS)} attempts after retryable settings lock timeouts.`,
  );
}

describe('YamlSettingsAdapter', () => {
  it('preserves two namespaces across two real writers with 100 updates each', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const adapter = new YamlSettingsAdapter(filename);

      async function writeAgentPresets(): Promise<void> {
        for (let sequence = 0; sequence < 100; sequence += 1) {
          await retrySettingsLockTimeout(`agent-presets update ${String(sequence)}`, () =>
            adapter.updateAgentPresets({ sequence }),
          );
        }
      }

      async function writeOtherNamespace(): Promise<void> {
        for (let sequence = 0; sequence < 100; sequence += 1) {
          await retrySettingsLockTimeout(`other-namespace update ${String(sequence)}`, () =>
            withSettingsFileLock(filename, async () => {
              let source = '';
              try {
                source = await readFile(filename, 'utf8');
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
              const document = parseDocument(source);
              document.setIn(['other-namespace', 'sequence'], sequence);
              await writeFileAtomic(filename, document.toString(), {
                mode: 0o600,
                dirMode: 0o700,
              });
            }),
          );
        }
      }

      await Promise.all([writeAgentPresets(), writeOtherNamespace()]);

      const text = await readFile(filename, 'utf8');
      const document = parseDocument(text);
      expect(document.errors).toEqual([]);
      const root = document.toJS() as Record<string, unknown>;
      expect(root['agent-presets']).toEqual({ sequence: 99 });
      expect(root['other-namespace']).toEqual({ sequence: 99 });
      await expect(readFile(`${filename}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 30_000);

  it('retries a real settings lock timeout once the lock is released', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const lockPath = `${filename}.lock`;
      const adapter = new YamlSettingsAdapter(filename, { clock: new FakeClock() });
      await writeFile(lockPath, '424242\n', { mode: 0o600, flag: 'wx' });
      let calls = 0;

      await retrySettingsLockTimeout('released settings lock', async () => {
        calls += 1;
        const result = await adapter.updateAgentPresets({ sequence: 1 });
        if (calls === 1) await rm(lockPath);
        return result;
      });

      expect(calls).toBe(2);
      expect(parseDocument(await readFile(filename, 'utf8')).toJS()).toEqual({
        'agent-presets': { sequence: 1 },
      });
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('keeps same-namespace concurrency last-write-wins without torn YAML', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const first = new YamlSettingsAdapter(filename);
      const second = new YamlSettingsAdapter(filename);

      async function writeSeries(adapter: YamlSettingsAdapter, writer: string): Promise<void> {
        for (let sequence = 0; sequence < 10; sequence += 1) {
          const result = await adapter.updateAgentPresets({ writer, sequence });
          expect(result.ok).toBe(true);
        }
      }

      await Promise.all([writeSeries(first, 'first'), writeSeries(second, 'second')]);

      const document = parseDocument(await readFile(filename, 'utf8'));
      expect(document.errors).toEqual([]);
      const root = document.toJS() as Record<string, unknown>;
      expect([
        { writer: 'first', sequence: 9 },
        { writer: 'second', sequence: 9 },
      ]).toContainEqual(root['agent-presets']);
    });
  });

  it('returns a sanitized Result and preserves an invalid on-disk document', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const invalid = 'agent-presets: [unterminated\n';
      await writeFile(filename, invalid, 'utf8');

      const result = await new YamlSettingsAdapter(filename).updateAgentPresets({ selected: 'x' });

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'E_SETTINGS_INVALID_YAML', path: filename }),
      ]);
      expect(JSON.stringify(result.diagnostics)).not.toContain('unterminated');
      expect(await readFile(filename, 'utf8')).toBe(invalid);
    });
  });

  it('uses deterministic 20-to-200ms backoff and returns timeout without stealing a lock', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const lockPath = `${filename}.lock`;
      const clock = new FakeClock();
      await writeFile(lockPath, '424242\n', { mode: 0o600, flag: 'wx' });

      const result = await new YamlSettingsAdapter(filename, { clock }).updateAgentPresets({
        selected: 'x',
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: 'E_SETTINGS_LOCK_TIMEOUT', path: lockPath }),
      ]);
      expect(clock.sleeps.slice(0, 4)).toEqual([20, 40, 80, 160]);
      expect(clock.sleeps.slice(4).every((delay) => delay === 200)).toBe(true);
      expect(clock.sleeps.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThanOrEqual(2_000);
      expect(await readFile(lockPath, 'utf8')).toBe('424242\n');
      await expect(readFile(filename, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('preserves untouched map comments while replacing a changed array with its comments', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      await writeFile(
        filename,
        [
          '# document-comment',
          'agent-presets:',
          '  stable: # stable-map-comment',
          '    model: keep # model-comment',
          '  changed:',
          '    # old-array-comment',
          '    - old',
          '  obsolete: remove-me',
          'other:',
          '  untouched: true # other-comment',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = await new YamlSettingsAdapter(filename).updateAgentPresets({
        stable: { model: 'keep', added: true },
        changed: ['new'],
      });

      expect(result.ok).toBe(true);
      const output = await readFile(filename, 'utf8');
      expect(output).toContain('# document-comment');
      expect(output).toContain('# stable-map-comment');
      expect(output).toContain('# model-comment');
      expect(output).toContain('# other-comment');
      expect(output).not.toContain('# old-array-comment');
      expect(output).not.toContain('obsolete:');
    });
  });

  it.each([
    [
      'an aliased agent-presets section',
      'shared: &shared\n  selected: old\nagent-presets: *shared\n',
    ],
    [
      'an anchored agent-presets section referenced by another namespace',
      'agent-presets: &shared\n  selected: old\nother-namespace: *shared\n',
    ],
  ])('rejects %s without changing another namespace through aliasing', async (_name, source) => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      await writeFile(filename, source, 'utf8');

      const result = await new YamlSettingsAdapter(filename).updateAgentPresets({
        selected: 'new',
      });

      expect(result).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_ALIAS', path: filename })],
      });
      expect(await readFile(filename, 'utf8')).toBe(source);
    });
  });

  it('deletes own prototype-named leaves that are absent from the next section', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      await writeFile(
        filename,
        'agent-presets:\n  toString: remove\n  constructor: remove\n  __proto__: remove\n  keep: yes\n',
        'utf8',
      );

      const result = await new YamlSettingsAdapter(filename).updateAgentPresets({ keep: 'yes' });

      expect(result.ok).toBe(true);
      expect(parseDocument(await readFile(filename, 'utf8')).toJS()).toEqual({
        'agent-presets': { keep: 'yes' },
      });
    });
  });

  it('runs the secret scan before commit and removes only its own lock on rejection', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const result = await new YamlSettingsAdapter(filename).updateAgentPresets({
        apiKey: 'sk-TESTONLY-00000000000000000000000000000000',
      });

      expect(result.ok).toBe(false);
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'E_SECRET_KEY')).toBe(
        true,
      );
      await expect(readFile(filename, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(`${filename}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('scans the candidate section without policing untouched user-owned namespaces', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      await writeFile(filename, 'other-namespace:\n  apiKey: locally-owned\n', 'utf8');

      const result = await new YamlSettingsAdapter(filename).updateAgentPresets({ selected: 'x' });

      expect(result.ok).toBe(true);
      const root = parseDocument(await readFile(filename, 'utf8')).toJS();
      expect(root).toEqual({
        'other-namespace': { apiKey: 'locally-owned' },
        'agent-presets': { selected: 'x' },
      });
    });
  });

  it('reads an absent document as an empty successful Result', async () => {
    await withScratch(async (directory) => {
      const result = await new YamlSettingsAdapter(join(directory, 'settings.yaml')).read();
      expect(result).toEqual({ ok: true, value: {}, diagnostics: [] });
    });
  });

  it('returns E_SETTINGS_IO Results for unreadable and uncreatable path hierarchies', async () => {
    await withScratch(async (directory) => {
      const blocker = join(directory, 'not-a-directory');
      const filename = join(blocker, 'missing', 'settings.yaml');
      await writeFile(blocker, 'occupied', 'utf8');
      const adapter = new YamlSettingsAdapter(filename);

      const readResult = await adapter.read();
      const updateResult = await adapter.updateAgentPresets({ selected: 'x' });

      expect(readResult).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_IO', path: filename })],
      });
      expect(updateResult).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_IO', path: filename })],
      });
    });
  });
});

describe('withSettingsFileLock', () => {
  it('does not delete a replacement lock installed by an external owner', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const lockPath = `${filename}.lock`;

      const result = await withSettingsFileLock(filename, async () => {
        expect(await readFile(lockPath, 'utf8')).toBe(`${process.pid}\n`);
        if (process.platform !== 'win32') expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
        // Keep the inode stable so this case specifically proves the PID payload check.
        // An inode-only release guard would incorrectly remove the external owner's lock.
        await writeFile(lockPath, 'external-owner\n', { mode: 0o600 });
        return 'finished';
      });

      expect(result).toEqual({ ok: true, value: 'finished', diagnostics: [] });
      expect(await readFile(lockPath, 'utf8')).toBe('external-owner\n');
    });
  });

  it('converts acquisition and operation failures to sanitized E_SETTINGS_IO Results', async () => {
    await withScratch(async (directory) => {
      const blocker = join(directory, 'not-a-directory');
      await writeFile(blocker, 'occupied', 'utf8');
      const acquisition = await withSettingsFileLock(join(blocker, 'settings.yaml'), async () => 1);
      expect(acquisition).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_IO' })],
      });

      const filename = join(directory, 'settings.yaml');
      const privateDetail = 'sensitive-operation-detail';
      const operation = await withSettingsFileLock(filename, async () => {
        throw Object.assign(new Error(privateDetail), { code: 'EIO' });
      });
      expect(operation).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_IO', path: filename })],
      });
      expect(JSON.stringify(operation)).not.toContain(privateDetail);
      await expect(readFile(`${filename}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('cleans the lock it created when writing the PID payload fails', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const lockPath = `${filename}.lock`;
      const result = await withSettingsFileLock(filename, async () => 'unreachable', {
        writeLockContents: async (handle) => {
          await handle.writeFile('', 'utf8');
          throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
        },
      });

      expect(result).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_IO', path: lockPath })],
      });
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await withSettingsFileLock(filename, async () => 'recovered')).toEqual({
        ok: true,
        value: 'recovered',
        diagnostics: [],
      });
    });
  });

  it('reports a lock-release failure instead of swallowing it or resolving success', async () => {
    await withScratch(async (directory) => {
      const filename = join(directory, 'settings.yaml');
      const lockPath = `${filename}.lock`;
      const privateDetail = 'sensitive-release-detail';

      const result = await withSettingsFileLock(filename, async () => 'operation-finished', {
        removeLock: async () => {
          throw Object.assign(new Error(privateDetail), { code: 'EIO' });
        },
      });

      expect(result).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'E_SETTINGS_IO', path: lockPath })],
      });
      expect(JSON.stringify(result)).not.toContain(privateDetail);
      expect(await readFile(lockPath, 'utf8')).toBe(`${process.pid}\n`);
    });
  });
});
