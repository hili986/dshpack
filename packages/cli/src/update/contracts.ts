/** Canonical encoding emitted by `encodeCanonicalSettingsValue`. */
export type CanonicalValue = string;

/**
 * A value summary used by three-way update merging.  Presence is explicit so an
 * absent value can never be confused with a present value whose canonical form
 * represents `null` (`null#0:` for settings).
 */
export type MergeState =
  | { readonly present: true; readonly canonicalValue: CanonicalValue }
  | { readonly present: false; readonly canonicalValue?: never };

/** Asset summaries currently use their stable digest or other summary string. */
export type AssetState = MergeState;

/** Settings summaries must use `encodeCanonicalSettingsValue` output. */
export type SettingsState = MergeState;

export type MergeAction =
  | 'unchanged'
  | 'update'
  | 'retain'
  | 'converged'
  | 'conflict'
  | 'create'
  | 'remove';

/**
 * Every decision retains the three compared summaries so callers can aggregate
 * conflicts without re-reading mutable state.
 */
export interface ThreeWayMergeResult<TState extends MergeState = MergeState> {
  readonly action: MergeAction;
  readonly base: TState;
  readonly current: TState;
  readonly target: TState;
}
