import type { Diagnostic, Severity } from '@dshpack/core';

import { EXIT_CODES, type ExitCode } from '../exit-codes.js';

export interface CommandReport<T extends object = Record<string, never>> {
  diagnostics: readonly Diagnostic[];
  exitCode: ExitCode;
  metadata: T;
}

export function diagnostic(
  code: string,
  severity: Severity,
  message: string,
  hint: string,
  path?: string,
): Diagnostic {
  return {
    code,
    severity,
    message,
    hint,
    evidence: 'local',
    ...(path === undefined ? {} : { path }),
  };
}

export function strictDiagnostics(
  diagnostics: readonly Diagnostic[],
  strict: boolean,
): readonly Diagnostic[] {
  return strict
    ? diagnostics.map((item) =>
        item.severity === 'warning' ? { ...item, severity: 'error' } : item,
      )
    : diagnostics;
}

/** Security errors take precedence so a caller can never downgrade a credential leak to contract noise. */
export function exitCodeFor(diagnostics: readonly Diagnostic[]): ExitCode {
  if (!diagnostics.some((item) => item.severity === 'error')) return EXIT_CODES.SUCCESS;
  if (diagnostics.some((item) => /^(?:E_SECRET|E_PATH|E_SETTINGS_MCP_ENV)/u.test(item.code))) {
    return EXIT_CODES.SECURITY;
  }
  return EXIT_CODES.CONTRACT;
}

export function writeReport<T extends object>(report: CommandReport<T>, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ diagnostics: report.diagnostics, ...report.metadata })}\n`,
    );
  } else {
    for (const item of report.diagnostics) {
      const prefix = item.severity === 'error' ? '✖' : item.severity === 'warning' ? '⚠' : 'ℹ';
      process.stderr.write(
        `${prefix} ${item.code}: ${item.message}${item.path ? ` (${item.path})` : ''}\n`,
      );
      if (item.hint) process.stderr.write(`  提示：${item.hint}\n`);
    }
  }
  process.exitCode = report.exitCode;
}

export function errorReport<T extends object>(
  code: string,
  message: string,
  metadata: T,
  exitCode: ExitCode = EXIT_CODES.CONTRACT,
): CommandReport<T> {
  return {
    diagnostics: [diagnostic(code, 'error', message, '修复输入后重试。')],
    exitCode,
    metadata,
  };
}
