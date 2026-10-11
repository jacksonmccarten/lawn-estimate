// The mock company-api's state: one seeded company, held in memory. A stand-in
// for services/lambdas + packages/db until step 4; it is never served by a
// deployed build (see next.config.ts and the route handler).

import type { Company, Lead, PricingVersion, PricingVersionContent, ServiceRadius, ServiceRegion, Usage } from "@lq/api-contract";
import { priceQuote } from "@lq/pricing";
import { PA_COUNTIES } from "@/lib/pa-counties";

export type Store = {
  company: Company;
  /** company_members: Cognito sub → company. The only way a request finds its company. */
  members: Map<string, string>;
  regions: ServiceRegion[];
  serviceRadius: ServiceRadius | null;
  versions: PricingVersion[];
  leads: Lead[];
  usage: Usage;
};

export const MOCK_OWNER_SUB = "mock-sub-owner-0001";
const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const uuid = (group: number, n: number) => `00000000-0000-4000-8000-${String(group).padStart(4, "0")}${String(n).padStart(8, "0")}`;

/** PA seed rates in basis points: 6%, 7% in Allegheny, 8% in Philadelphia. An unknown county has no rate (R4). */
export function taxRateBpsFor(county: string): number | null {
  if (!(PA_COUNTIES as readonly string[]).includes(county)) return null;
  return county === "Allegheny" ? 700 : county === "Philadelphia" ? 800 : 600;
}

/** What a new, empty draft starts from: a few services from the PA catalog, flags as seeded there. */
/** Centre points of the handful of zip codes the mock knows, for "zip codes within N miles". */
export const ZIP_CENTRES: Record<string, readonly [number, number]> = {
  "16801": [40.78521, -77.842297],
  "16803": [40.802336, -77.899858],
  "16827": [40.762, -77.7722],
  "16823": [40.9336, -77.7762],
  "16870": [40.8027, -78.0556],
  "15217": [40.4308, -79.9203],
  "19103": [39.953372, -75.174187],
};

export const CATALOG_DEFAULTS: PricingVersionContent["services"] = [
  { code: "mow", name: "Mowing, trimming and edging", taxable: true, season: "growing" },
  { code: "aerate", name: "Aerating", taxable: true, season: "growing" },
  { code: "leaf_raking", name: "Leaf raking", taxable: false, season: "growing" },
];

const v1: PricingVersionContent = {
  minChargeCents: 4000,
  coverageFactor: 0.7,
  services: CATALOG_DEFAULTS,
  tiers: [
    { serviceCode: "mow", regionGroup: "core", minSqft: 0, maxSqft: 5000, pricePerSqftMicrocents: null, flatPriceCents: 4000 },
    { serviceCode: "mow", regionGroup: "core", minSqft: 5000, maxSqft: 10000, pricePerSqftMicrocents: 700_000, flatPriceCents: null },
    { serviceCode: "mow", regionGroup: "core", minSqft: 10000, maxSqft: 20000, pricePerSqftMicrocents: 650_000, flatPriceCents: null },
    { serviceCode: "mow", regionGroup: "outer", minSqft: 0, maxSqft: 5000, pricePerSqftMicrocents: null, flatPriceCents: 5000 },
    { serviceCode: "mow", regionGroup: "outer", minSqft: 5000, maxSqft: 20000, pricePerSqftMicrocents: 800_000, flatPriceCents: null },
    { serviceCode: "aerate", regionGroup: "core", minSqft: 0, maxSqft: 20000, pricePerSqftMicrocents: null, flatPriceCents: 9000 },
    { serviceCode: "leaf_raking", regionGroup: "core", minSqft: 0, maxSqft: 20000, pricePerSqftMicrocents: null, flatPriceCents: 12000 },
  ],
};

const v2: PricingVersionContent = {
  ...v1,
  minChargeCents: 4500,
  tiers: v1.tiers.map((t) =>
    t.serviceCode === "mow" && t.regionGroup === "core" && t.minSqft === 0
      ? { ...t, flatPriceCents: 4500 }
      : t.serviceCode === "mow" && t.regionGroup === "core" && t.minSqft === 5000
        ? { ...t, pricePerSqftMicrocents: 750_000 }
        : t,
  ),
};

const PEOPLE = ["Avery Kline", "Jordan Reese", "Sam Okafor", "Riley Novak", "Casey Brandt", "Morgan Ellis", "Devon Hart", "Quinn Mercer"];
const PLACES = [
  { town: "State College", zip: "16801", county: "Centre", group: "core" },
  { town: "Bellefonte", zip: "16823", county: "Centre", group: "outer" },
  { town: "Pittsburgh", zip: "15217", county: "Allegheny", group: "core" },
] as const;

function seedLeads(versions: PricingVersion[]): Lead[] {
  const newest = Date.parse("2026-10-09T15:00:00Z");
  const leads: Lead[] = [];
  for (let i = 0; i < 32; i++) {
    const place = PLACES[i % PLACES.length]!;
    const version = i < 24 ? versions[1]! : versions[0]!;
    const parcelSqft = 6000 + ((i * 1700) % 16000);
    const footprintSqft = 1500 + ((i * 300) % 1500);
    const grassSqft = Math.max(100, Math.round(((parcelSqft - footprintSqft) * version.content.coverageFactor) / 100) * 100);
    const priced = priceQuote({
      version: { id: version.id, ...version.content },
      serviceCode: "mow",
      addOnCodes: place.group === "core" && i % 4 === 0 ? ["leaf_raking"] : [],
      grassSqft,
      regionGroup: place.group,
      taxRateBps: taxRateBpsFor(place.county)!,
    });
    if (!priced.ok) throw new Error(`seed lead ${i} did not price: ${priced.reason}`);
    const { versionId: _versionId, ...quote } = priced.quote;
    const status = i % 11 === 10 ? "expired" : i % 7 === 3 ? "accepted" : i % 7 === 5 ? "declined" : "submitted";
    const manual = i % 6 === 4;
    leads.push({
      id: uuid(2, i + 1),
      quoteId: uuid(3, i + 1),
      status,
      createdAt: new Date(newest - i * 5 * 3_600_000).toISOString(),
      contact: {
        name: PEOPLE[i % PEOPLE.length]!,
        phone: i % 5 === 2 ? null : `814-555-01${String(i).padStart(2, "0")}`,
        email: i % 5 === 1 ? null : `lead${i + 1}@example.com`,
      },
      addressText: `${100 + i * 12} Example St, ${place.town}, PA ${place.zip}`,
      county: place.county,
      origin: manual ? "manual" : i % 6 === 1 ? "regrid_adjusted" : "regrid",
      parcelSqft: manual ? null : parcelSqft,
      footprintSqft: manual ? null : footprintSqft,
      grassSqft,
      quote,
      pricingVersionId: version.id,
      adjustedTotalCents: status === "accepted" && i % 14 === 3 ? quote.totalCents + 1000 : null,
    });
  }
  return leads;
}

function seed(): Store {
  const versions: PricingVersion[] = [
    { id: uuid(1, 1), version: 1, createdAt: "2026-02-20T14:00:00Z", publishedAt: "2026-03-01T14:00:00Z", content: v1 },
    { id: uuid(1, 2), version: 2, createdAt: "2026-06-10T14:00:00Z", publishedAt: "2026-06-15T14:00:00Z", content: v2 },
  ];
  return {
    company: {
      id: COMPANY_ID,
      slug: "nittany-lawn",
      name: "Nittany Lawn Care",
      hicNo: null,
      allowedOrigins: ["https://www.nittanylawn.example"],
      theme: { color: "#1f6b3a" },
    },
    members: new Map([[MOCK_OWNER_SUB, COMPANY_ID]]),
    regions: [
      { kind: "zip", value: "16801", tierGroup: "core" },
      { kind: "zip", value: "16803", tierGroup: "core" },
      { kind: "zip", value: "16823", tierGroup: "outer" },
      { kind: "zip", value: "15217", tierGroup: "core" },
    ],
    serviceRadius: null,
    versions,
    leads: seedLeads(versions),
    usage: { month: "2026-10-01", regridLookups: 212, quotes: 187, regridLookupQuota: 1000 },
  };
}

// Route handlers can be loaded as separate module instances; keep one store per process.
const holder = globalThis as typeof globalThis & { __lqMockStore?: Store };

export function getStore(): Store {
  return (holder.__lqMockStore ??= seed());
}

export function resetStore(): void {
  holder.__lqMockStore = seed();
}
