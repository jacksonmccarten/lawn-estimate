import { defineConfig } from "@playwright/test";

// Ports of their own, so this suite can run beside `npm run dev` and the
// dashboard's. HOST_PORT is also in fixtures/profiles.json, as the origin
// joes-lawn allows to embed it.
const PORT = 3101;
const HOST_PORT = 3102;
// The same build again with a Mapbox token, for the aerial photo screen
// (e2e/yard.spec.ts stubs Mapbox itself). MAP_ORIGIN in e2e/support.ts.
const MAP_PORT = 3103;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    browserName: "chromium",
    // The size the widget is built at (docs/ENGINEERING_DESIGN.md section 14, step 5).
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // The production build, so the Content-Security-Policy under test is
      // the one that ships; `next dev` relaxes it.
      command: `npm run build && npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}/v1.js`,
      // Empty, so a developer's .env.local cannot turn the aerial photo on for this server.
      env: { LQ_FIXTURES: "1", NEXT_PUBLIC_MAPBOX_TOKEN: "" },
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // Started after the first has built; the token is read per request, not at build time.
      command: `npx next start -p ${MAP_PORT}`,
      url: `http://localhost:${MAP_PORT}/v1.js`,
      env: { LQ_FIXTURES: "1", NEXT_PUBLIC_MAPBOX_TOKEN: "pk.e2e-not-a-real-token" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node e2e/host-server.mjs ${HOST_PORT} http://localhost:${PORT}`,
      url: `http://127.0.0.1:${HOST_PORT}/`,
      reuseExistingServer: false,
    },
  ],
});
