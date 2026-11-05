// Runs the renderer in a plain browser against an in-memory mock backend.
// Useful for UI work without Electron: `npm run web`.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared') } },
  plugins: [react()],
  define: { 'import.meta.env.VITE_MOCK_BACKEND': JSON.stringify('1') },
  build: { outDir: resolve(import.meta.dirname, 'out/web'), emptyOutDir: true },
});
