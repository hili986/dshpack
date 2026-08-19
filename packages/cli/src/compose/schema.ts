import type { ComposeManifest } from '@dshpack/core';

export type ComposeSelection = ComposeManifest['include'][number];
export type ComposeResolution = NonNullable<ComposeManifest['resolve']>[number];

export interface ComposeSourceItem {
  bytes: Uint8Array;
  from: string;
  id: string;
  license?: string;
  originalPath: string;
  sourcePath: string;
}
