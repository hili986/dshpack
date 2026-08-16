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
      POST_INSTALL_VERIFY_FAILURE: 24,
      MANUAL_RECOVERY_REQUIRED: 25,
      CONTRACT: 30,
      SECURITY: 31,
      INTERNAL: 70,
    });
  });

  // 24 and 25 demand opposite operator responses and must never collapse into one
  // code: 24 means the machine was restored to its pre-install state (retry is safe),
  // 25 means it was left mid-flight (retry would write onto dirty state).
  it('keeps clean-rollback and manual-recovery on distinct codes', () => {
    expect(EXIT_CODES.POST_INSTALL_VERIFY_FAILURE).not.toBe(EXIT_CODES.MANUAL_RECOVERY_REQUIRED);
  });
});
