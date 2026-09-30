import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { vibeProjects } from './vite/projects-plugin';

const repo = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./app', import.meta.url)),
  resolve: {
    alias: {
      '@vibe/shared': repo('packages/shared/src/index.ts'),
      '@vibe/engine': repo('packages/engine/src/index.ts'),
      '@vibe/runtime': repo('packages/runtime/src/index.ts'),
      '@vibe/server': repo('packages/server/src/index.ts'),
    },
  },
  plugins: [vibeProjects(repo('projects'))],
  server: {
    port: 5173,
    fs: { allow: [repo('')] },
  },
});
