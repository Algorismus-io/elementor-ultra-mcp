import { defineConfig } from 'vitest/config';

// The live contract suites are named *.contract.ts on purpose (kept out of the default
// *.test.* include so the offline unit run never touches them); this config is the only
// place that includes them. Requires WP_URL / WP_USER / WP_APP_PASSWORD (suites self-skip
// without them).
export default defineConfig({
  test: {
    include: ['src/test-harness/**/*.contract.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
