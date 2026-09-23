import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwind()],
  server: {
    port: 5173,
    // The API runs as its own process; everything under /api goes to it, so
    // the browser sees one origin and the refresh cookie behaves normally.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
