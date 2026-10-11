// Headers that do not depend on the company. The per-company
// Content-Security-Policy of /w/[company] is set by the page itself.

const nosniff = { key: "X-Content-Type-Options", value: "nosniff" };

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // packages/api-contract ships TypeScript source whose imports use the
  // NodeNext spelling ("./common.js" for common.ts).
  transpilePackages: ["@lq/api-contract"],
  experimental: { extensionAlias: { ".js": [".ts", ".js"] } },
  async headers() {
    return [
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
