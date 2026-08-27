import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { app: 'src/main.ts' },
  format: ['esm'],
  platform: 'browser',
  dts: false,
  sourcemap: false,
  hash: false,
  outDir: '../cli/dist/ui',
  outExtensions: () => ({ js: '.js' }),
  // The CLI build is the sole owner of cleaning dist/. This build runs after it and only adds UI.
  clean: false,
  copy: { from: 'public/index.html', to: '../cli/dist/ui', flatten: true },
});
