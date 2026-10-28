import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { penFsPlugin } from './server/fsPlugin';

// The workspace is the folder whose .pen files the standalone editor can open (defaults to ./examples).
const workspace = process.env.PEN_WORKSPACE || path.resolve(__dirname, 'examples');

export default defineConfig({
  plugins: [react(), penFsPlugin(workspace)],
  // Relative asset paths so the build can be served from a VS Code webview.
  base: './',
  build: { outDir: 'dist/webview', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5178, strictPort: false, host: '127.0.0.1' },
});
