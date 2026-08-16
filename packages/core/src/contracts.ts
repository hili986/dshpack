export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
  hint?: string;
  evidence: 'official' | 'local' | 'needs-test';
}

export interface Result<T> {
  ok: boolean;
  value?: T;
  diagnostics: readonly Diagnostic[];
}
