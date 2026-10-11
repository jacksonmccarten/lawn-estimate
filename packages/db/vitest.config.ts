import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each database suite builds its own database, but roles are cluster-wide:
    // two files running the migrations at once collide.
    fileParallelism: false,
  },
});
