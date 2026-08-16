export interface ProcessAdapter {
  readonly argv: readonly string[];
  writeStderr(message: string): void;
  setExitCode(code: number): void;
}
