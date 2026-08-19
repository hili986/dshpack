import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const binPath =
  process.env.DSHPACK_E2E_BIN === undefined
    ? fileURLToPath(new URL('../dist/bin.js', import.meta.url))
    : resolve(process.env.DSHPACK_E2E_BIN);
const commands = [
  'export',
  'install',
  'list',
  'switch',
  'doctor',
  'validate',
  'lock',
  'init',
  'pack',
] as const;

describe('dshpack --help', () => {
  it('lists every top-level command from the built executable', () => {
    const result = spawnSync(process.execPath, [binPath, '--help'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    for (const command of commands) {
      expect(result.stdout).toMatch(new RegExp(`^\\s{2}${command}\\b`, 'm'));
    }
  });

  for (const command of ['init', 'pack'] as const) {
    it(`${command} reports its implemented validation contract`, () => {
      const args = command === 'pack' ? [command, 'missing-source'] : [command];
      const result = spawnSync(process.execPath, [binPath, ...args], {
        encoding: 'utf8',
      });

      expect(result.status).toBe(command === 'init' ? 21 : 30);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        command === 'init' ? 'E_INIT_REQUIRED' : 'E_SOURCE_DIRECTORY',
      );
    });
  }

  it.each(['validate', 'doctor', 'export', 'install', 'list', 'switch', 'lock'])(
    '%s exposes implemented help instead of the W10 placeholder',
    (command) => {
      const result = spawnSync(process.execPath, [binPath, command, '--help'], {
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('未实现（W10+）');
    },
  );

  it.each([['list'], ['switch', 'demo']])(
    '%s executes its implemented environment gate',
    (...args) => {
      const result = spawnSync(process.execPath, [binPath, ...args], {
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: '' },
      });

      expect(result.status).toBe(10);
      expect(result.stderr).toContain('DSH_HOME');
      expect(result.stderr).not.toContain('未实现');
    },
  );

  it('maps Commander usage failures to exit 2 without leaking a stack', () => {
    const result = spawnSync(process.execPath, [binPath, '--definitely-unknown'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error: unknown option '--definitely-unknown'");
    expect(result.stderr).not.toContain('CommanderError');
  });

  it('emits one JSON object for a usage failure in JSON mode', () => {
    const result = spawnSync(process.execPath, [binPath, '--json', '--definitely-unknown'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: [expect.objectContaining({ code: 'E_USAGE', severity: 'error' })],
    });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it.each([['switch'], ['list', 'extra']])(
    'maps child-command schema failure to exit 2: %j',
    (...args) => {
      const result = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });

      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('error:');
      expect(result.stderr).not.toContain('CommanderError');
    },
  );

  it('keeps child-command JSON schema failure to one stdout object', () => {
    const result = spawnSync(process.execPath, [binPath, '--json', 'switch'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      diagnostics: [expect.objectContaining({ code: 'E_USAGE', severity: 'error' })],
    });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it.each([
    ['root', ['--json', '--help']],
    ['child', ['list', '--json', '--help']],
  ] as const)('emits one JSON help object for %s placement', (_placement, args) => {
    const result = spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ diagnostics: [], help: expect.any(String) });
  });
});
