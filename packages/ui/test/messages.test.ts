import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { message, messageKeys, messages } from '../src/messages.js';

describe('UI message catalog', () => {
  it('provides the closed runtime translation catalog', () => {
    expect(existsSync(fileURLToPath(new URL('../src/messages.ts', import.meta.url)))).toBe(true);
  });

  it('supplies a non-empty Chinese and English value for every closed key', () => {
    for (const key of messageKeys) {
      expect(messages.zh[key]).not.toBe('');
      expect(messages.en[key]).not.toBe('');
      expect(message('zh', key)).toBe(messages.zh[key]);
      expect(message('en', key)).toBe(messages.en[key]);
    }
  });
});
