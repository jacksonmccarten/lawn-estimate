import { defineConfig } from "vitest/config";

// The handler suites a second time, with every statement sent as the text
// the Data API client would send (parameters written in as literals).
export default defineConfig({
  test: {
    include: ["test/public.test.ts", "test/company-api.test.ts"],
    env: { LQ_TEST_DRIVER: "data-api-sql" },
    fileParallelism: false,
  },
});
