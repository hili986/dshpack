import { describe, expectTypeOf, it } from 'vitest';

import type { Diagnostic, Result, Severity } from '../src/index.js';

describe('public contracts', () => {
  it('exports the specified severity union', () => {
    expectTypeOf<Severity>().toEqualTypeOf<'error' | 'warning' | 'info'>();
  });

  it('exports the specified diagnostic shape', () => {
    expectTypeOf<Diagnostic>().toEqualTypeOf<{
      code: string;
      severity: Severity;
      message: string;
      path?: string;
      hint?: string;
      evidence: 'official' | 'local' | 'needs-test';
    }>();
  });

  it('exports the specified generic result shape', () => {
    expectTypeOf<Result<number>>().toEqualTypeOf<{
      ok: boolean;
      value?: number;
      diagnostics: readonly Diagnostic[];
    }>();
  });
});
