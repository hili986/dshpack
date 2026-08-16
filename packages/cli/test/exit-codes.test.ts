import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/exit-codes.js';

describe('EXIT_CODES', () => {
  it('matches the complete public exit-code contract', () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      USAGE: 2,
      ENVIRONMENT: 10,
      SOURCE_NETWORK_INTEGRITY: 20,
      USER_DECLINED: 21,
      PROFILE_CONFLICT_OR_LOCK: 22,
      DSH_SUBPROCESS_FAILURE: 23,
      POST_INSTALL_OR_ROLLBACK_FAILURE: 24,
      CONTRACT: 30,
      SECURITY: 31,
      INTERNAL: 70,
    });
  });
});
