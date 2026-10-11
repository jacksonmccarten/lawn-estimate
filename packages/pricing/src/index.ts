// The pricing engine: a company's pricing version applied to a grass area.
// Rules only (R20). Pure: no I/O, no clock, no randomness, inputs never mutated.
// All money is integer cents; every intermediate value is an integer.

export type Service = {
  code: string;
  name: string;
  /** Sales tax applies to this service's line (R1). */
  taxable: boolean;
};

/** Covers minSqft < grassSqft <= maxSqft, at exactly one of the two prices. */
export type Tier = {
  serviceCode: string;
  regionGroup: string;
  minSqft: number;
  maxSqft: number;
  /** Millionths of a cent per square foot: $0.0075/sqft is 750_000. */
  pricePerSqftMicrocents: number | null;
  flatPriceCents: number | null;
};

/** A pricing version with its services and tiers loaded. */
export type PricingVersion = {
  id: string;
  minChargeCents: number;
  services: readonly Service[];
  tiers: readonly Tier[];
};

export type PricingInput = {
  version: PricingVersion;
  /** The service being quoted. The minimum charge applies to its line. */
  serviceCode: string;
  /** Extra services, each priced from its own tiers and kept as its own line (R3). */
  addOnCodes?: readonly string[];
  grassSqft: number;
  regionGroup: string;
  /** County sales tax in basis points: 6% is 600. From tax_rates, never defaulted (R4). */
  taxRateBps: number;
};

export type QuoteLine = {
  serviceCode: string;
  name: string;
  amountCents: number;
  taxable: boolean;
};

export type Quote = {
  /** One line per service, in the order requested. Never merged (R2, R3). */
  lines: QuoteLine[];
  subtotalCents: number;
  taxableSubtotalCents: number;
  taxRateBps: number;
  taxCents: number;
  totalCents: number;
  versionId: string;
};

export type PricingResult =
  | { ok: true; quote: Quote }
  /** The version does not sell this service. */
  | { ok: false; reason: "unknown_service"; serviceCode: string }
  /** No tier covers this size in this region: "no price for this size; call us". */
  | { ok: false; reason: "no_tier"; serviceCode: string };

function assertInt(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
}

/** Integer division rounding half up; both arguments are non-negative integers. */
function divRound(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator)) throw new RangeError("amount is too large to price exactly");
  const quotient = Math.floor(numerator / denominator);
  return (numerator % denominator) * 2 >= denominator ? quotient + 1 : quotient;
}

function findTier(version: PricingVersion, serviceCode: string, regionGroup: string, grassSqft: number): Tier | undefined {
  return version.tiers.find(
    (t) =>
      t.serviceCode === serviceCode &&
      t.regionGroup === regionGroup &&
      grassSqft > t.minSqft &&
      grassSqft <= t.maxSqft,
  );
}

function laborCents(tier: Tier, grassSqft: number): number {
  if (tier.pricePerSqftMicrocents !== null) {
    assertInt("pricePerSqftMicrocents", tier.pricePerSqftMicrocents, 0);
    return divRound(grassSqft * tier.pricePerSqftMicrocents, 1_000_000);
  }
  if (tier.flatPriceCents !== null) {
    assertInt("flatPriceCents", tier.flatPriceCents, 0);
    return tier.flatPriceCents;
  }
  throw new RangeError(`tier for ${tier.serviceCode} has neither a per-sqft rate nor a flat price`);
}

/**
 * Prices one quote. Returns a failure for the two cases a caller must handle
 * (the service is not sold, or no tier covers the size); throws RangeError for
 * input that can only come from a bug.
 */
export function priceQuote(input: PricingInput): PricingResult {
  const { version, grassSqft, regionGroup, taxRateBps } = input;
  assertInt("grassSqft", grassSqft, 0);
  assertInt("taxRateBps", taxRateBps, 0);
  assertInt("minChargeCents", version.minChargeCents, 0);
  if (taxRateBps >= 10_000) throw new RangeError(`taxRateBps must be below 10000, got ${taxRateBps}`);

  const lines: QuoteLine[] = [];
  for (const [index, serviceCode] of [input.serviceCode, ...(input.addOnCodes ?? [])].entries()) {
    const service = version.services.find((s) => s.code === serviceCode);
    if (!service) return { ok: false, reason: "unknown_service", serviceCode };
    if (lines.some((l) => l.serviceCode === serviceCode)) {
      throw new RangeError(`service ${serviceCode} is requested twice`);
    }
    const tier = findTier(version, serviceCode, regionGroup, grassSqft);
    if (!tier) return { ok: false, reason: "no_tier", serviceCode };

    const labor = laborCents(tier, grassSqft);
    // The minimum charge belongs to the quoted service, so it is taxed as that service is.
    const amountCents = index === 0 ? Math.max(version.minChargeCents, labor) : labor;
    lines.push({ serviceCode, name: service.name, amountCents, taxable: service.taxable });
  }

  const sum = (ls: QuoteLine[]) => ls.reduce((total, l) => total + l.amountCents, 0);
  const subtotalCents = sum(lines);
  const taxableSubtotalCents = sum(lines.filter((l) => l.taxable));
  // Tax is computed once on the taxable subtotal, never per line and never on the whole quote.
  const taxCents = divRound(taxableSubtotalCents * taxRateBps, 10_000);

  return {
    ok: true,
    quote: {
      lines,
      subtotalCents,
      taxableSubtotalCents,
      taxRateBps,
      taxCents,
      totalCents: subtotalCents + taxCents,
      versionId: version.id,
    },
  };
}
