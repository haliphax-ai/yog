import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Reuse a single worker/module registry across files. Faster as the suite
    // grows; keep tests free of cross-file global state.
    isolate: false,
    tags: [
      {
        name: "mount",
        description: "Live FUSE mount integration tests (require /dev/fuse)",
      },
    ],
  },
});
