import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const commands = [
  'export',
  'install',
  'list',
  'switch',
  'doctor',
  'validate',
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

  for (const command of ['install', 'list', 'switch', 'init', 'pack'] as const) {
    it(`${command} reports the placeholder contract`, () => {
      const result = spawnSync(process.execPath, [binPath, command], {
        encoding: 'utf8',
      });

      expect(result.status).toBe(70);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('未实现（W10+）\n');
    });
  }

  it.each(['validate', 'doctor', 'export'])(
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
});
