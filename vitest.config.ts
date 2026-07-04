import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // Production defaults are 0% fee / no deposit; tests pin non-zero values
    // so the fee and deposit machinery stays fully exercised.
    env: {
      PLATFORM_FEE_BPS: '1000',
      APPEAL_DEPOSIT_BPS: '500',
      // The suite runs on the always-PASS stub judge (no provider keys in CI),
      // so it opts into stub auto-pass. The dedicated fail-closed test flips
      // this back on to prove judged orders hold when no real judge exists.
      REQUIRE_REAL_JUDGES: 'false',
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
