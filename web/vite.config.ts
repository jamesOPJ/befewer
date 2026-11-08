import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
export default defineConfig({
  base: './', // relative asset paths: works at / and behind the /p/5043/ preview proxy
  plugins: [svelte()],
  // some wallet dependencies (randombytes, under Meteor's SDK) read Node's `global`, which browsers
  // do not have: "global is not defined" when connecting a wallet
  define: { global: 'globalThis' },
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
})
