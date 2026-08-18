import { describe, expect, it } from 'vitest';

import { encodeCanonicalSettingsValue } from '../src/metadata/state-storage.js';
import type { AssetState, SettingsState } from '../src/update/contracts.js';
import { mergeAssetState, mergeSettingsState } from '../src/update/merge.js';

const missingAsset: AssetState = { present: false };
const missingSettings: SettingsState = { present: false };

function asset(summary: string): AssetState {
  return { present: true, canonicalValue: summary };
}

function setting(value: unknown): SettingsState {
  return { present: true, canonicalValue: encodeCanonicalSettingsValue(value) };
}

function expectAssetAction(
  base: AssetState,
  current: AssetState,
  target: AssetState,
  action: ReturnType<typeof mergeAssetState>['action'],
): void {
  expect(mergeAssetState(base, current, target)).toEqual({ action, base, current, target });
}

function expectSettingsAction(
  base: SettingsState,
  current: SettingsState,
  target: SettingsState,
  action: ReturnType<typeof mergeSettingsState>['action'],
): void {
  expect(mergeSettingsState(base, current, target)).toEqual({ action, base, current, target });
}

describe('update asset three-way merge', () => {
  it('A|A|A is unchanged', () => {
    const value = asset('asset#A');
    expectAssetAction(value, value, value, 'unchanged');
  });

  it('A|A|B is an update', () => {
    expectAssetAction(asset('asset#A'), asset('asset#A'), asset('asset#B'), 'update');
  });

  it('A|B|A retains the user-modified asset', () => {
    expectAssetAction(asset('asset#A'), asset('asset#B'), asset('asset#A'), 'retain');
  });

  it('A|B|B is converged', () => {
    expectAssetAction(asset('asset#A'), asset('asset#B'), asset('asset#B'), 'converged');
  });

  it('A|B|C conflicts', () => {
    expectAssetAction(asset('asset#A'), asset('asset#B'), asset('asset#C'), 'conflict');
  });

  it('A|missing|B retains the user-deleted asset', () => {
    expectAssetAction(asset('asset#A'), missingAsset, asset('asset#B'), 'retain');
  });

  it('missing|missing|B creates the asset', () => {
    expectAssetAction(missingAsset, missingAsset, asset('asset#B'), 'create');
  });

  it('A|A|missing removes the asset', () => {
    expectAssetAction(asset('asset#A'), asset('asset#A'), missingAsset, 'remove');
  });

  it('A|B|missing retains the user-modified asset', () => {
    expectAssetAction(asset('asset#A'), asset('asset#B'), missingAsset, 'retain');
  });
});

describe('update settings three-way merge', () => {
  it('A|A|A is unchanged', () => {
    const value = setting('A');
    expectSettingsAction(value, value, value, 'unchanged');
  });

  it('A|A|B is an update', () => {
    expectSettingsAction(setting('A'), setting('A'), setting('B'), 'update');
  });

  it('A|B|A retains the user-modified setting', () => {
    expectSettingsAction(setting('A'), setting('B'), setting('A'), 'retain');
  });

  it('A|B|B is converged', () => {
    expectSettingsAction(setting('A'), setting('B'), setting('B'), 'converged');
  });

  it('A|B|C conflicts', () => {
    expectSettingsAction(setting('A'), setting('B'), setting('C'), 'conflict');
  });

  it('A|missing|B retains the user-deleted setting', () => {
    expectSettingsAction(setting('A'), missingSettings, setting('B'), 'retain');
  });

  it('missing|missing|B creates the setting', () => {
    expectSettingsAction(missingSettings, missingSettings, setting('B'), 'create');
  });

  it('A|A|missing removes the setting', () => {
    expectSettingsAction(setting('A'), setting('A'), missingSettings, 'remove');
  });

  it('A|B|missing retains the user-modified setting', () => {
    expectSettingsAction(setting('A'), setting('B'), missingSettings, 'retain');
  });

  it('distinguishes -0 from 0 through canonical settings values', () => {
    expect(encodeCanonicalSettingsValue(-0)).not.toBe(encodeCanonicalSettingsValue(0));
    expectSettingsAction(setting(-0), setting(0), setting(-0), 'retain');
  });

  it('distinguishes NaN from null through canonical settings values', () => {
    expect(encodeCanonicalSettingsValue(Number.NaN)).not.toBe(encodeCanonicalSettingsValue(null));
    expectSettingsAction(setting(Number.NaN), setting(null), setting(Number.NaN), 'retain');
  });

  it('distinguishes a missing setting from a present null setting', () => {
    const nullSetting = setting(null);
    expect(nullSetting.canonicalValue).toBe('null#0:');
    expectSettingsAction(missingSettings, missingSettings, nullSetting, 'create');
  });
});
