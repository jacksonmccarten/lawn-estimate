import { defineConfig, devices } from "@playwright/test";

const port = 3100;

export default defineConfig({
  testDir: "e2e",
  // The mock company-api keeps one in-memory company; tests reset it and run in turn.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // A production build, so axe sees what ships and not the dev overlay.
    command: `npm run build && npm run start -- -p ${port}`,
    url: `http://localhost:${port}/sign-in`,
    env: { LQ_MOCK: "1" },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
