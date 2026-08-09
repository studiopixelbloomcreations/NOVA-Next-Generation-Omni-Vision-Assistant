import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  // Official brand icon served into the renderer bundle (favicon).
  publicDir: 'src/renderer/public',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      // The renderer HTML entry lives under src/renderer (the repo-root
      // index.html is the Electron window, not a Vite page).
      input: 'src/renderer/index.html',
      output: {
        // Code splitting: keep the heavy HLS player and UI vendors in separate
        // chunks so the boot-critical bundle stays small and each chunk is
        // well under Vite's 500 kB warning threshold.
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'hls-player': ['hls.js'],
          'ui-icons': ['lucide-react'],
        },
      },
    },
  },
});
