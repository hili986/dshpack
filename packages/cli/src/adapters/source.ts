export interface SourceAdapter {
  fetch(reference: string): Promise<Uint8Array>;
}
