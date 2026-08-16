import { describe, expect, it } from 'vitest';

import { versionAtLeast } from '../src/doctor/support.js';

describe('doctor support', () => {
  it('accepts the exact minimum semantic version', () => {
    expect(versionAtLeast('10.0.0', [10, 0, 0])).toBe(true);
    expect(versionAtLeast('22.19.0', [22, 19, 0])).toBe(true);
    expect(versionAtLeast('10.0.1', [10, 0, 0])).toBe(true);
    expect(versionAtLeast('9.99.99', [10, 0, 0])).toBe(false);
    expect(versionAtLeast('not-a-version', [10, 0, 0])).toBe(false);
  });
});
