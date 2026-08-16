export const EXIT_CODES = {
  SUCCESS: 0,
  USAGE: 2,
  ENVIRONMENT: 10,
  SOURCE_NETWORK_INTEGRITY: 20,
  USER_DECLINED: 21,
  PROFILE_CONFLICT_OR_LOCK: 22,
  DSH_SUBPROCESS_FAILURE: 23,
  /** Post-install verification failed and the transaction rolled back cleanly: the
   * machine is back to its pre-install state, so retrying is safe. */
  POST_INSTALL_VERIFY_FAILURE: 24,
  /** The rollback itself failed, or a lock could not be released: the machine was left
   * mid-flight and the caller was handed explicit manual recovery steps. Retrying
   * without acting on them would write onto dirty state. Raised exactly when a result
   * carries a non-empty `manualRecovery`. */
  MANUAL_RECOVERY_REQUIRED: 25,
  CONTRACT: 30,
  SECURITY: 31,
  INTERNAL: 70,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
