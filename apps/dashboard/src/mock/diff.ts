import type { PricingVersion, PricingVersionDiff, Service, Tier } from "@lq/api-contract";
import { tierKey } from "@/lib/tiers";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function compare<T>(from: readonly T[], to: readonly T[], key: (item: T) => string) {
  const before = new Map(from.map((item) => [key(item), item]));
  const after = new Map(to.map((item) => [key(item), item]));
  return {
    added: to.filter((item) => !before.has(key(item))),
    removed: from.filter((item) => !after.has(key(item))),
    changed: to.flatMap((item) => {
      const old = before.get(key(item));
      return old && !same(old, item) ? [{ from: old, to: item }] : [];
    }),
  };
}

/** A draft against the current published version, as GET /pricing-versions/{id}/diff describes it. */
export function diffVersions(draft: PricingVersion, published: PricingVersion | null): PricingVersionDiff {
  const base = published?.content ?? null;
  const next = draft.content;
  const services = compare<Service>(base?.services ?? [], next.services, (s) => s.code);
  const tiers = compare<Tier>(base?.tiers ?? [], next.tiers, tierKey);
  const minChargeCents = base && base.minChargeCents !== next.minChargeCents ? { from: base.minChargeCents, to: next.minChargeCents } : null;
  const coverageFactor = base && base.coverageFactor !== next.coverageFactor ? { from: base.coverageFactor, to: next.coverageFactor } : null;
  const lists = [services.added, services.removed, services.changed, tiers.added, tiers.removed, tiers.changed];
  return {
    draftId: draft.id,
    publishedId: published?.id ?? null,
    identical: base !== null && !minChargeCents && !coverageFactor && lists.every((l) => l.length === 0),
    minChargeCents,
    coverageFactor,
    services,
    tiers,
  };
}
