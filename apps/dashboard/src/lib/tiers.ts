import type { Tier } from "@lq/api-contract";

/**
 * Pairs of tiers whose ranges overlap for the same service and region group.
 * A tier covers minSqft < area <= maxSqft, so 0–5,000 and 5,000–10,000 do not
 * overlap. The database rejects overlaps with an exclusion constraint; this is
 * the same rule, so the owner hears about it before saving.
 */
export function findOverlaps(tiers: readonly Tier[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const groups = new Map<string, number[]>();
  tiers.forEach((t, i) => {
    const key = `${t.serviceCode}\u0000${t.regionGroup}`;
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  });
  for (const group of groups.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const first = tiers[group[a]!]!;
        const second = tiers[group[b]!]!;
        if (first.minSqft < second.maxSqft && second.minSqft < first.maxSqft) pairs.push([group[a]!, group[b]!]);
      }
    }
  }
  return pairs;
}

/** How the diff matches a tier: service, region group and sqft range. */
export function tierKey(t: Tier): string {
  return [t.serviceCode, t.regionGroup, t.minSqft, t.maxSqft].join("\u0000");
}
