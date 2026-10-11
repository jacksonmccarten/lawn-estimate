// The pricing editor's form model. Inputs hold text; the contract holds
// integers. `fromForm` turns one into the other and names every problem by the
// id of the field it belongs to, so the editor can link each message to its
// input and list them all in the error summary.

import { PricingVersionContent, RegionGroup, ServiceCode, type Tier } from "@lq/api-contract";
import {
  centsToInput,
  parseDollars,
  parseRatePer1000,
  parseWholeNumber,
  rateToInput,
} from "./money";
import { findOverlaps } from "./tiers";

export type ServiceRow = {
  key: string;
  code: string;
  name: string;
  /** Empty until the owner chooses: a service's tax treatment is never defaulted (R1). */
  taxable: "" | "yes" | "no";
  season: "growing" | "winter";
};

export type TierRow = {
  key: string;
  serviceCode: string;
  regionGroup: string;
  minSqft: string;
  maxSqft: string;
  priceKind: "per_sqft" | "flat";
  price: string;
};

export type PricingForm = {
  minCharge: string;
  /** Carried through unchanged and not shown: nothing uses it now that the area a homeowner gives is counted in full. */
  coverageFactor: number;
  services: ServiceRow[];
  tiers: TierRow[];
};

export type FieldError = { fieldId: string; label: string; message: string };

let nextKey = 0;
export const newKey = () => `r${++nextKey}`;

export function tierToRow(t: Tier): TierRow {
  return {
    key: newKey(),
    serviceCode: t.serviceCode,
    regionGroup: t.regionGroup,
    minSqft: String(t.minSqft),
    maxSqft: String(t.maxSqft),
    priceKind: t.pricePerSqftMicrocents !== null ? "per_sqft" : "flat",
    price: t.pricePerSqftMicrocents !== null ? rateToInput(t.pricePerSqftMicrocents) : centsToInput(t.flatPriceCents ?? 0),
  };
}

export function toForm(content: PricingVersionContent): PricingForm {
  return {
    minCharge: centsToInput(content.minChargeCents),
    coverageFactor: content.coverageFactor,
    services: content.services.map((s) => ({ key: newKey(), code: s.code, name: s.name, taxable: s.taxable ? "yes" : "no", season: s.season })),
    tiers: content.tiers.map(tierToRow),
  };
}

export const fieldId = {
  minCharge: "min-charge",
  service: (key: string, field: "code" | "name" | "taxable" | "season") => `service-${key}-${field}`,
  tier: (key: string, field: "service" | "region" | "min" | "max" | "kind" | "price") => `tier-${key}-${field}`,
};

export type FormResult = { ok: true; content: PricingVersionContent } | { ok: false; errors: FieldError[] };

export function fromForm(form: PricingForm): FormResult {
  const errors: FieldError[] = [];
  const add = (id: string, label: string, message: string) => errors.push({ fieldId: id, label, message });

  const minChargeCents = parseDollars(form.minCharge);
  if (minChargeCents === null) add(fieldId.minCharge, "Minimum charge", "Enter a dollar amount, such as 45.00");
  const { coverageFactor } = form;

  const codes = new Set<string>();
  const services: PricingVersionContent["services"] = [];
  form.services.forEach((row, i) => {
    const label = `Service ${i + 1}`;
    const code = row.code.trim();
    const name = row.name.trim();
    if (!code) add(fieldId.service(row.key, "code"), `${label}, code`, "Enter a code");
    else if (!ServiceCode.safeParse(code).success) add(fieldId.service(row.key, "code"), `${label}, code`, "Use lowercase letters, digits and underscores, 40 at most");
    else if (codes.has(code)) add(fieldId.service(row.key, "code"), `${label}, code`, `Another service already uses the code "${code}"`);
    codes.add(code);
    if (!name) add(fieldId.service(row.key, "name"), `${label}, name`, "Enter a name");
    else if (name.length > 120) add(fieldId.service(row.key, "name"), `${label}, name`, "Use 120 characters or fewer");
    if (row.taxable === "") add(fieldId.service(row.key, "taxable"), `${label}, sales tax`, "Choose whether sales tax applies to this service");
    services.push({ code, name, taxable: row.taxable === "yes", season: row.season });
  });

  const tiers: Tier[] = [];
  const complete: boolean[] = [];
  form.tiers.forEach((row, i) => {
    const label = `Tier ${i + 1}`;
    const before = errors.length;
    if (!row.serviceCode) add(fieldId.tier(row.key, "service"), `${label}, service`, "Choose a service");
    else if (!codes.has(row.serviceCode)) add(fieldId.tier(row.key, "service"), `${label}, service`, `No service with the code "${row.serviceCode}" in this version`);
    const regionGroup = row.regionGroup.trim();
    if (!regionGroup) add(fieldId.tier(row.key, "region"), `${label}, region group`, "Enter a region group, such as core");
    else if (!RegionGroup.safeParse(regionGroup).success) add(fieldId.tier(row.key, "region"), `${label}, region group`, "Use 40 characters or fewer");
    const minSqft = parseWholeNumber(row.minSqft);
    if (minSqft === null) add(fieldId.tier(row.key, "min"), `${label}, from`, "Enter a whole number of square feet, 0 or more");
    const maxSqft = parseWholeNumber(row.maxSqft);
    if (maxSqft === null) add(fieldId.tier(row.key, "max"), `${label}, up to`, "Enter a whole number of square feet");
    else if (minSqft !== null && maxSqft <= minSqft) add(fieldId.tier(row.key, "max"), `${label}, up to`, "Must be greater than the “from” value");
    const price = row.priceKind === "per_sqft" ? parseRatePer1000(row.price) : parseDollars(row.price);
    if (price === null) {
      add(
        fieldId.tier(row.key, "price"),
        `${label}, price`,
        row.priceKind === "per_sqft" ? "Enter dollars per 1,000 sq ft, such as 7.50" : "Enter a dollar amount, such as 45.00",
      );
    }
    complete.push(errors.length === before);
    tiers.push({
      serviceCode: row.serviceCode,
      regionGroup,
      minSqft: minSqft ?? 0,
      maxSqft: maxSqft ?? 0,
      pricePerSqftMicrocents: row.priceKind === "per_sqft" ? price : null,
      flatPriceCents: row.priceKind === "flat" ? price : null,
    });
  });

  // Overlaps are only meaningful between rows that are otherwise sound.
  const sound = tiers.map((t, i) => ({ t, i })).filter(({ i }) => complete[i]);
  for (const [a, b] of findOverlaps(sound.map(({ t }) => t))) {
    const first = sound[a]!.i;
    const second = sound[b]!.i;
    add(fieldId.tier(form.tiers[second]!.key, "min"), `Tier ${second + 1}, from`, `This range overlaps tier ${first + 1} for the same service and region group`);
  }

  if (errors.length > 0 || minChargeCents === null) return { ok: false, errors };

  // The contract has the last word; anything it rejects that the checks above
  // missed is still reported rather than sent.
  const content = { minChargeCents, coverageFactor, services, tiers };
  const parsed = PricingVersionContent.safeParse(content);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const [list, index] = issue.path;
      const row = list === "tiers" ? form.tiers[Number(index)] : list === "services" ? form.services[Number(index)] : undefined;
      if (list === "tiers" && row) add(fieldId.tier(row.key, "price"), `Tier ${Number(index) + 1}`, issue.message);
      else if (list === "services" && row) add(fieldId.service(row.key, "code"), `Service ${Number(index) + 1}`, issue.message);
      else add(fieldId.minCharge, "Pricing version", issue.message);
    }
    return { ok: false, errors };
  }
  return { ok: true, content: parsed.data };
}

/** Whether two forms would save the same thing, ignoring row keys. */
export function sameForm(a: PricingForm, b: PricingForm): boolean {
  const strip = (f: PricingForm) => ({
    minCharge: f.minCharge,
    services: f.services.map(({ key: _key, ...rest }) => rest),
    tiers: f.tiers.map(({ key: _key, ...rest }) => rest),
  });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
