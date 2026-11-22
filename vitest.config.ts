import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Several tests start one process per probe. On a busy runner that is
    // more than the 5 second default.
    testTimeout: 30_000,
  },
});
