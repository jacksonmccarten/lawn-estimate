// The pricing editor's form model: lawn-size categories, each with one flat
// rate. Inputs hold text; the contract holds integers. `fromForm` turns one
// into the other and names every problem by the id of the field it belongs
// to, so the editor can link each message to its input and list them all in
// the error summary.
//
// The categories are contiguous by construction: each row has only an upper
// bound, the next row starts just above it, and the last row has no upper
// bound. So there are never overlaps or gaps. Underneath they are still the
// contract's tiers, written for the mowing service in each of the company's
// region groups, so other services can be added later without a new model.

import { PricingVersionContent, type Service, type Tier } from "@lq/api-contract";
import { centsToInput, parseDollars, parseWholeNumber } from "./money";

/** The one service quoted for now. */
export const MOWING: Service = { code: "mow", name: "Lawn mowing", taxable: true, season: "growing" };

/** The last category's upper bound: larger than any lawn a homeowner can draw or enter. */
export const OPEN_END_SQFT = 1_000_000_000;

export type CategoryRow = {
  key: string;
  /** Up to and including, in square feet. Ignored on the last row, which has no upper bound. */
  upTo: string;
  price: string;
};

export type PricingForm = {
  categories: CategoryRow[];
};

export type FieldError = { fieldId: string; label: string; message: string };

let nextKey = 0;
export const newKey = () => `r${++nextKey}`;

/** Example categories for a version that has none yet. */
export const EXAMPLE_CATEGORIES: ReadonlyArray<{ upTo: number; cents: number }> = [
  { upTo: 2_500, cents: 4_500 },
  { upTo: 5_000, cents: 5_000 },
  { upTo: 10_000, cents: 6_000 },
  { upTo: 15_000, cents: 7_500 },
  { upTo: OPEN_END_SQFT, cents: 9_000 },
];

/** The mowing service a version prices: its own, or the default. */
export function mowingService(content: PricingVersionContent): Service {
  return content.services.find((s) => s.code === MOWING.code) ?? MOWING;
}

/**
 * The categories a version holds: its mowing tiers in one region group, in
 * order of size. A tier priced per square foot (from before flat rates) comes
 * through with no price, for the owner to fill in.
 */
export function categoriesOf(content: PricingVersionContent): Tier[] {
  const mow = content.tiers.filter((t) => t.serviceCode === mowingService(content).code);
  const group = [...new Set(mow.map((t) => t.regionGroup))].sort()[0];
  return mow.filter((t) => t.regionGroup === group).sort((a, b) => a.minSqft - b.minSqft);
}

export function toForm(content: PricingVersionContent): PricingForm {
  const tiers = categoriesOf(content);
  if (tiers.length === 0) {
    return { categories: EXAMPLE_CATEGORIES.map((c) => ({ key: newKey(), upTo: String(c.upTo), price: centsToInput(c.cents) })) };
  }
  return {
    categories: tiers.map((t) => ({
      key: newKey(),
      upTo: String(t.maxSqft),
      price: t.flatPriceCents !== null ? centsToInput(t.flatPriceCents) : "",
    })),
  };
}

export const fieldId = {
  category: (key: string, field: "max" | "price") => `category-${key}-${field}`,
};

/** "0–2,500 sq ft", "2,501–5,000 sq ft", "15,001+ sq ft". */
export function rangeLabel(from: number, upTo: number | null): string {
  const n = (v: number) => v.toLocaleString("en-US");
  if (upTo === null || upTo >= OPEN_END_SQFT) return `${n(from === 0 ? 0 : from + 1)}+ sq ft`;
  return `${n(from === 0 ? 0 : from + 1)}–${n(upTo)} sq ft`;
}

export type FormResult = { ok: true; content: PricingVersionContent } | { ok: false; errors: FieldError[] };

/**
 * The version content for a form: the mowing service and its categories as
 * flat-rate tiers in every region group the company has. No minimum charge:
 * the price is the category's flat rate.
 */
export function fromForm(form: PricingForm, base: PricingVersionContent, regionGroups: readonly string[]): FormResult {
  const errors: FieldError[] = [];
  const add = (id: string, label: string, message: string) => errors.push({ fieldId: id, label, message });

  if (form.categories.length === 0) add("add-category", "Lawn size categories", "Add at least one lawn size category");

  const bounds: { min: number; max: number; cents: number }[] = [];
  let from = 0;
  form.categories.forEach((row, i) => {
    const label = `Category ${i + 1}`;
    const last = i === form.categories.length - 1;
    let max = OPEN_END_SQFT;
    if (!last) {
      const upTo = parseWholeNumber(row.upTo);
      if (upTo === null || upTo === 0) add(fieldId.category(row.key, "max"), `${label}, up to`, "Enter a whole number of square feet");
      else if (upTo <= from) add(fieldId.category(row.key, "max"), `${label}, up to`, `Must be more than ${from.toLocaleString("en-US")}, where the category above ends`);
      else if (upTo >= OPEN_END_SQFT) add(fieldId.category(row.key, "max"), `${label}, up to`, "Enter a smaller number of square feet");
      else max = upTo;
    }
    const cents = parseDollars(row.price);
    if (cents === null) add(fieldId.category(row.key, "price"), `${label}, flat rate`, "Enter a dollar amount, such as 45.00");
    bounds.push({ min: from, max, cents: cents ?? 0 });
    if (max > from) from = max;
  });

  if (errors.length > 0) return { ok: false, errors };

  const service = mowingService(base);
  const groups = regionGroups.length > 0 ? [...new Set(regionGroups)].sort() : ["standard"];
  const tiers: Tier[] = groups.flatMap((regionGroup) =>
    bounds.map((b) => ({
      serviceCode: service.code,
      regionGroup,
      minSqft: b.min,
      maxSqft: b.max,
      pricePerSqftMicrocents: null,
      flatPriceCents: b.cents,
    })),
  );

  // The contract has the last word; anything it rejects that the checks above
  // missed is still reported rather than sent.
  const parsed = PricingVersionContent.safeParse({ minChargeCents: 0, coverageFactor: base.coverageFactor, services: [service], tiers });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add("add-category", "Pricing", issue.message);
    return { ok: false, errors };
  }
  return { ok: true, content: parsed.data };
}

/** Whether two forms would save the same thing, ignoring row keys. */
export function sameForm(a: PricingForm, b: PricingForm): boolean {
  const strip = (f: PricingForm) => f.categories.map((c, i) => ({ upTo: i === f.categories.length - 1 ? "" : c.upTo, price: c.price }));
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
