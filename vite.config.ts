import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the app from /<repo-name>/. Override with BASE_PATH if you
// host it somewhere else (e.g. BASE_PATH=/ for a custom domain).
export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH ?? '/setlist/',
});
