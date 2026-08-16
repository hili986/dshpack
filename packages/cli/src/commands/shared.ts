import { isAbsolute, resolve } from 'node:path';

import type { Diagnostic, Severity } from '@dshpack/core';
import type { Command } from 'commander';

import { EXIT_CODES, type ExitCode } from '../exit-codes.js';

export interface CommandReport<T extends object = Record<string, never>> {
  diagnostics: readonly Diagnostic[];
  exitCode: ExitCode;
  metadata: T;
}

export type DshHomeResolution = { ok: true; value: string } | { ok: false; report: CommandReport };

function containsUnsafePathControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function dshHomeFailure(
  code: string,
  message: string,
  hint: string,
  exitCode: ExitCode,
): DshHomeResolution {
  return {
    ok: false,
    report: {
      diagnostics: [diagnostic(code, 'error', message, hint)],
      exitCode,
      metadata: {},
    },
  };
}

function dshHomeRequiredFailure(): DshHomeResolution {
  return dshHomeFailure(
    'E_DSH_HOME_REQUIRED',
    'DSH_HOME 必须是非空绝对路径。',
    '请通过 --dsh-home 或 DSH_HOME 设置绝对路径。',
    EXIT_CODES.ENVIRONMENT,
  );
}

/** Resolve an explicit safe home before command engines can perform I/O. */
export function resolveDshHomeValue(configured: string | undefined): DshHomeResolution {
  if (configured === undefined) return dshHomeRequiredFailure();
  const value = configured.trim();
  if (value.length === 0) return dshHomeRequiredFailure();
  if (containsUnsafePathControl(configured)) {
    return dshHomeFailure(
      'E_PATH_DSH_HOME',
      'DSH_HOME 路径包含不安全的控制字符。',
      '请设置不含 C0、C1 或 DEL 控制字符的绝对路径。',
      EXIT_CODES.SECURITY,
    );
  }
  if (!isAbsolute(value))
    return dshHomeFailure(
      'E_PATH_DSH_HOME',
      'DSH_HOME 必须是绝对路径，已拒绝相对路径。',
      '请通过 --dsh-home 或 DSH_HOME 设置绝对路径。',
      EXIT_CODES.SECURITY,
    );
  return { ok: true, value: resolve(value) };
}

/** Resolve the root command option or environment without exposing rejected input. */
export function resolveDshHome(program: Command): DshHomeResolution {
  const rootValue = program.opts<{ dshHome?: string }>().dshHome;
  return resolveDshHomeValue(rootValue ?? process.env.DSH_HOME);
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
  if (
    diagnostics.some((item) =>
      /^(?:E_SECRET|E_PATH|E_SETTINGS_MCP_ENV|E_MCP_CREDENTIAL)/u.test(item.code),
    )
  ) {
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
