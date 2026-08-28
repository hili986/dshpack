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

  it('keeps the new empty-state guidance bilingual and user-actionable', () => {
    const zh = messages.zh as Record<string, string>;
    const en = messages.en as Record<string, string>;

    expect(zh.guidePackFromOverview).toBe('请先在总览中选择 Profile 并点击“查看 Pack”。');
    expect(zh.guideDiffFromOverview).toBe('请先在总览中选择 Profile 并点击“查看漂移”。');
    expect(zh.noDrift).toBe('无漂移：本地内容与锁定一致。');
    expect(en.guidePackFromOverview).toBe(
      'First select a Profile in Overview, then click “View Pack”.',
    );
    expect(en.guideDiffFromOverview).toBe(
      'First select a Profile in Overview, then click “View Drift”.',
    );
    expect(en.noDrift).toBe('No drift: local content matches the lock.');
  });
});
