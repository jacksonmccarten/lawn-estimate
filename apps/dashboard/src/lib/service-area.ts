// A company's service areas as the Service area screen shows them, and their
// translation to and from the flat list of regions the API stores.
//
// Stored, a region is a county or a zip code, each with a region group. Shown,
// a service area is a region group: its name, and the counties and zip codes
// in it. A new company has one, `standard`, holding every Pennsylvania
// county. An area made on the screen is the zip codes within a distance of a
// place. At pricing time a zip region wins over a county region, so inside a
// zip-code area its own prices apply.

import type { ServiceRegion } from "@lq/api-contract";

export type ServiceArea = {
  /** The region group, which is what a pricing tier names. */
  group: string;
  counties: string[];
  zips: string[];
};

/** The areas, in the order their groups first appear. */
export function toAreas(regions: readonly ServiceRegion[]): ServiceArea[] {
  const areas = new Map<string, ServiceArea>();
  for (const region of regions) {
    const area = areas.get(region.tierGroup) ?? { group: region.tierGroup, counties: [], zips: [] };
    (region.kind === "county" ? area.counties : area.zips).push(region.value);
    areas.set(region.tierGroup, area);
  }
  return [...areas.values()].map((a) => ({ ...a, counties: a.counties.sort(), zips: a.zips.sort() }));
}

export function toRegions(areas: readonly ServiceArea[]): ServiceRegion[] {
  return areas.flatMap((area) => [
    ...area.counties.map((value) => ({ kind: "county" as const, value, tierGroup: area.group })),
    ...area.zips.map((value) => ({ kind: "zip" as const, value, tierGroup: area.group })),
  ]);
}

/** What an area covers, in a few words. */
export function describeArea(area: ServiceArea, countiesInState: number): string {
  const parts: string[] = [];
  if (area.counties.length === countiesInState) parts.push("all of Pennsylvania");
  else if (area.counties.length > 0) parts.push(`${area.counties.length} ${area.counties.length === 1 ? "county" : "counties"}`);
  if (area.zips.length > 0) parts.push(`${area.zips.length} zip code${area.zips.length === 1 ? "" : "s"}`);
  return parts.join(" and ") || "nothing";
}

/**
 * A name as a region group: lower case, words joined by hyphens, at most 40
 * characters. Empty when nothing usable is left.
 */
export function groupName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * Adds an area made of zip codes. A zip code can be in one area only (the
 * API refuses a region listed twice), so zip codes another area already
 * has stay there; `skipped` says how many.
 */
export function addArea(areas: readonly ServiceArea[], group: string, zips: readonly string[]): { areas: ServiceArea[]; added: number; skipped: number } {
  const taken = new Set(areas.flatMap((a) => a.zips));
  const fresh = [...new Set(zips)].filter((zip) => !taken.has(zip)).sort();
  if (fresh.length === 0) return { areas: [...areas], added: 0, skipped: zips.length };
  return { areas: [...areas, { group, counties: [], zips: fresh }], added: fresh.length, skipped: zips.length - fresh.length };
}

export function removeArea(areas: readonly ServiceArea[], group: string): ServiceArea[] {
  return areas.filter((a) => a.group !== group);
}
