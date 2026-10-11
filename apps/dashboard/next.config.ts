import type { NextConfig } from "next";

// One switch for everything local: the mock sign-in and the mock company-api.
// On in `next dev`; off in a production build unless LQ_MOCK=1 is set at build
// time (Playwright does that). A deployed build never serves either.
const mock = process.env.LQ_MOCK ?? (process.env.NODE_ENV === "development" ? "1" : "0");

// LQ_CANONICAL_ORIGIN (set in Amplify, read at build time): the app's one
// public origin. A request on any other host (the amplifyapp.com address,
// www.) is sent there for good. The API only answers browsers on the
// canonical origins, so a page served elsewhere could not get an estimate.
// Amplify's own redirect rules do not reach server-rendered pages, so it is
// done here. Unset (local runs, tests): no redirect.
const canonical = process.env.LQ_CANONICAL_ORIGIN ? new URL(process.env.LQ_CANONICAL_ORIGIN) : null;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The workspace packages ship TypeScript source.
  transpilePackages: ["@lq/api-contract", "@lq/pricing"],
  // Their relative imports are written "./x.js" (NodeNext) and point at "./x.ts".
  // Turbopack has no equivalent of extensionAlias, so dev and build run with
  // --webpack (see package.json).
  webpack(webpackConfig) {
    webpackConfig.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return webpackConfig;
  },
  env: {
    NEXT_PUBLIC_LQ_MOCK: mock === "1" ? "1" : "0",
    // Where the company-api lives. The mock is served by this app.
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? (mock === "1" ? "/mock-api" : ""),
    // The Cognito user pool and its app client (the LqApi stack's outputs). Not secrets.
    NEXT_PUBLIC_COGNITO_USER_POOL_ID: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "",
    NEXT_PUBLIC_COGNITO_CLIENT_ID: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "",
    // The widget origins, for the embed snippet and the hosted page link.
    NEXT_PUBLIC_WIDGET_SCRIPT_ORIGIN: process.env.NEXT_PUBLIC_WIDGET_SCRIPT_ORIGIN ?? "https://widget.example.test",
    NEXT_PUBLIC_WIDGET_APP_ORIGIN: process.env.NEXT_PUBLIC_WIDGET_APP_ORIGIN ?? "https://w.example.test",
  },
  async redirects() {
    if (!canonical) return [];
    return [
      {
        source: "/:path*",
        missing: [{ type: "host", value: escapeRegex(canonical.host) }],
        destination: `${canonical.origin}/:path*`,
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The dashboard is never framed; the widget lives on another origin.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // HTTPS only, for a year, on every name under the domain (the API and the widget are HTTPS too).
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default config;
