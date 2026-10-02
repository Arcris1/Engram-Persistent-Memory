import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [vue()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0, cssCodeSplit: false },
});
