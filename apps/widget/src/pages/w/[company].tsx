// /w/[company]: the widget, and the hosted page when nothing embeds it
// (docs/ENGINEERING_DESIGN.md section 4). Rendered on the server from the
// company's public profile, with a Content-Security-Policy whose
// frame-ancestors is that company's allowlist.

import type { GetServerSideProps } from "next";
import Head from "next/head";
import { Widget, type WidgetProps } from "../../components/Widget";
import { serverConfig } from "../../server/config";
import { buildCsp } from "../../server/csp";
import { loadProfile } from "../../server/profile";
import { resolveBrand } from "../../theme/brand";

export const getServerSideProps: GetServerSideProps<WidgetProps> = async ({ params, res }) => {
  const config = serverConfig();
  const slug = typeof params?.company === "string" ? params.company : "";
  const profile = await loadProfile(slug, config);

  res.setHeader(
    "Content-Security-Policy",
    buildCsp({
      allowedOrigins: profile ? profile.allowedOrigins : null,
      apiOrigin: config.apiOrigin,
      logoOrigin: config.logoBaseUrl,
      turnstile: config.turnstileSiteKey !== null,
      mapbox: config.mapboxToken !== null,
      dev: config.dev,
    }),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!profile) return { notFound: true };

  // The profile changes when the company publishes; a short shared cache
  // keeps the page off the origin without holding a stale allowlist for long.
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=600");

  return {
    props: {
      company: { slug: profile.slug, name: profile.name, services: profile.services, logoUrl: profile.logoUrl },
      brand: resolveBrand(profile.color),
      allowedOrigins: profile.allowedOrigins,
      apiBase: config.apiBase,
      turnstileSiteKey: config.turnstileSiteKey,
      mapboxToken: config.mapboxToken,
    },
  };
};

export default function WidgetPage(props: WidgetProps) {
  return (
    <>
      <Head>
        <title>{`Instant lawn quote from ${props.company.name}`}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <Widget {...props} />
    </>
  );
}
