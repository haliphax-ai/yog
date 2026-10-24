import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    tags: [
      {
        name: "mount",
        description: "Live FUSE mount integration tests (require /dev/fuse)",
      },
    ],
  },
});
