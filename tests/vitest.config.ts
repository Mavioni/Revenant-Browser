import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: __dirname,
  test: {
    include: ['unit/**/*.test.ts'],
    environment: 'node',
    // Unit tests must not touch Electron — fail fast if someone imports it.
    server: {
      deps: {
        external: ['electron'],
      },
    },
  },
});
