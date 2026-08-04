import { describe, expect, it } from 'vitest';
import { SHARED_PACKAGE_NAME, type Empty } from '@elementor-ultra/shared';

// Trivial scaffold test (WP-F01): proves the vitest runner + NodeNext tsconfig
// resolve, AND that the cross-package workspace import (@elementor-ultra/shared)
// resolves at runtime and at the type level. Richer suites are WP-F06 / Q##.
//
// NB: we intentionally do NOT import './index.js' here — its top-level entry runs
// on import (it is the bin). The bin's clean-exit behaviour is covered by the
// build+boot smoke step (WP-F07), not a unit test.
describe('server scaffold', () => {
  it('imports the shared package constant across the workspace', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@elementor-ultra/shared');
  });

  it('imports a shared type across the workspace', () => {
    const empty: Empty = {};
    expect(Object.keys(empty)).toHaveLength(0);
  });
});
