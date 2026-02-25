import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/app',
  publicDir: '../../static',
  build: {
    outDir: '../../dist',
    emptyOutDir: false,
  },
  server: {
    port: 3000,
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
});
