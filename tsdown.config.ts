import { defineConfig } from 'tsdown';

export default defineConfig({
  format: 'esm',
  exports: true,
  sourcemap: true,
  publint: true,
  attw: { profile: 'esm-only', level: 'error' },
});
