// Headers that do not depend on the company. The per-company
// Content-Security-Policy of /w/[company] is set by the page itself.

const nosniff = { key: "X-Content-Type-Options", value: "nosniff" };
// HTTPS only, for a year, on every name under the domain.
const hsts = { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" };

// LQ_CANONICAL_ORIGIN (set in Amplify, read at build time): the app's one
// public origin. A request on any other host (the amplifyapp.com address,
// www.) is sent there for good. The API only answers browsers on the
// canonical origins, so a page served elsewhere could not get an estimate.
// Amplify's own redirect rules do not reach server-rendered pages, so it is
// done here. Unset (local runs, tests): no redirect.
const canonical = process.env.LQ_CANONICAL_ORIGIN ? new URL(process.env.LQ_CANONICAL_ORIGIN) : null;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // packages/api-contract ships TypeScript source whose imports use the
  // NodeNext spelling ("./common.js" for common.ts).
  transpilePackages: ["@lq/api-contract"],
  experimental: { extensionAlias: { ".js": [".ts", ".js"] } },
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
      { source: "/:path*", headers: [hsts] },
      {
        // docs/ENGINEERING_DESIGN.md section 12, caching contract.
        source: "/v1.js",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }, nosniff],
      },
      {
        // The content-hashed copy, for hosts that pin a version with SRI.
        source: "/embed/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }, nosniff],
      },
      {
        // Nothing but the widget route may be framed.
        source: "/((?!w/).*)",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }, nosniff],
      },
    ];
  },
};

export default nextConfig;
