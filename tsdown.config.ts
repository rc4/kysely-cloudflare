import { defineConfig } from 'tsdown';

export default defineConfig({
  format: ['esm', 'cjs'],
  exports: true,
  sourcemap: true,
  publint: true,
  attw: { profile: 'node16', level: 'error' },
});
