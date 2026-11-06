import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
export default defineConfig({
  base: './', // relative asset paths: works at / and behind the /p/5043/ preview proxy
  plugins: [svelte()],
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
})
