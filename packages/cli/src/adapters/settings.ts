export interface SettingsAdapter {
  read(): Promise<Readonly<Record<string, unknown>>>;
}
