import type { AssetState, MergeState, SettingsState, ThreeWayMergeResult } from './contracts.js';

function sameState(left: MergeState, right: MergeState): boolean {
  return (
    left.present === right.present &&
    (!left.present || left.canonicalValue === right.canonicalValue)
  );
}

/**
 * Decide a pure three-way merge from immutable summaries.  The same state
 * equality drives assets and settings; settings are intentionally not parsed.
 */
export function mergeThreeWayState<TState extends MergeState>(
  base: TState,
  current: TState,
  target: TState,
): ThreeWayMergeResult<TState> {
  if (sameState(current, target)) {
    return { action: sameState(base, current) ? 'unchanged' : 'converged', base, current, target };
  }

  if (sameState(base, current)) {
    if (!target.present) return { action: 'remove', base, current, target };
    return { action: base.present ? 'update' : 'create', base, current, target };
  }

  if (!current.present || !target.present || sameState(base, target)) {
    return { action: 'retain', base, current, target };
  }

  return { action: 'conflict', base, current, target };
}

/** Merge an asset from its stable summary string. */
export function mergeAssetState(
  base: AssetState,
  current: AssetState,
  target: AssetState,
): ThreeWayMergeResult<AssetState> {
  return mergeThreeWayState(base, current, target);
}

/** Merge a setting solely from its canonical encoded value. */
export function mergeSettingsState(
  base: SettingsState,
  current: SettingsState,
  target: SettingsState,
): ThreeWayMergeResult<SettingsState> {
  return mergeThreeWayState(base, current, target);
}
