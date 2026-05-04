import { defineConfig } from 'vite'

export default defineConfig({
  root: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Preserve original asset filenames — no content-hash suffix.
    // script.js is raw-copied (not processed by Vite) so it must
    // reference assets by their exact original names, e.g.
    // ./assets/kvf-bg-loop.mp4 — hashing would break those paths.
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name][extname]',
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
      },
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
})
