import { describe, expect, it } from 'vitest';

import { digestTargetBeforeState } from '../src/install/build-plan.js';
import { prepareInstallPlan } from '../src/install/plan.js';
import { fixture, input, manifest } from './install-plan-fixture.js';

describe('install plan external state binding', () => {
  it('binds an external default preset path, existence, and digest into before-state', async () => {
    const pack = manifest();
    pack.defaults.agentPreset = 'external';
    const root = await fixture({ manifest: pack });
    const base = input(root);
    const stateA = {
      ...base.environment.targetBeforeState,
      externalDefaultPreset: {
        path: '.agent-presets/external',
        state: 'present' as const,
        sha256: 'sha256-external-a',
      },
    };
    const stateB = {
      ...stateA,
      externalDefaultPreset: { ...stateA.externalDefaultPreset, sha256: 'sha256-external-b' },
    };
    const first = await prepareInstallPlan({
      ...base,
      environment: {
        ...base.environment,
        targetBeforeState: stateA,
        targetBeforeStateDigest: digestTargetBeforeState(stateA),
      },
    });
    const second = await prepareInstallPlan({
      ...base,
      environment: {
        ...base.environment,
        targetBeforeState: stateB,
        targetBeforeStateDigest: digestTargetBeforeState(stateB),
      },
    });
    expect(first.exitCode).toBe(0);
    expect(first.plan).toMatchObject({
      beforeState: { externalDefaultPreset: stateA.externalDefaultPreset },
      defaults: { agentPreset: { value: 'external', source: 'environment' } },
    });
    expect(first.plan?.stateDigest).not.toBe(second.plan?.stateDigest);

    const wrongPath = {
      ...stateA,
      externalDefaultPreset: { ...stateA.externalDefaultPreset, path: '.agent-presets/other' },
    };
    const rejected = await prepareInstallPlan({
      ...base,
      environment: {
        ...base.environment,
        targetBeforeState: wrongPath,
        targetBeforeStateDigest: digestTargetBeforeState(wrongPath),
      },
    });
    expect(rejected).toMatchObject({ exitCode: 30 });
    expect(rejected.diagnostics[0]).toMatchObject({ code: 'E_DEFAULT_PRESET_STATE' });
  });
});
