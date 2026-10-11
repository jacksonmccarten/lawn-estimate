// The grass estimate of design section 6, and the address handling around it.
// Pure. Areas are whole square feet; the coverage factor arrives as integer
// hundredths (0.70 is 70) so no floating-point value decides a price.

import type { ManualSize } from "@lq/api-contract";

export const SQFT_PER_ACRE = 43_560;
/** Above this the formula is skipped and the homeowner is asked for the size. */
export const MAX_FORMULA_PARCEL_SQFT = 2 * SQFT_PER_ACRE;

/** With no footprint to subtract, the coverage factor drops by this much instead. */
const NO_FOOTPRINT_PENALTY_HUNDREDTHS = 10;

const BUCKET_LOT_SQFT: Record<Extract<ManualSize, { kind: "bucket" }>["bucket"], number> = {
  quarter_acre: SQFT_PER_ACRE / 4,
  half_acre: SQFT_PER_ACRE / 2,
  one_acre: SQFT_PER_ACRE,
  two_plus_acres: 2 * SQFT_PER_ACRE,
};

export type GrassEstimate = { grassSqft: number; assumptions: string[] };

/** Nearest 100, half up. */
export function round100(sqft: number): number {
  return Math.floor((sqft + 50) / 100) * 100;
}

/** A lot with no building footprint: the factor, less the penalty, on the whole lot. */
function wholeLot(lotSqft: number, coverageHundredths: number): number {
  const factor = Math.max(0, coverageHundredths - NO_FOOTPRINT_PENALTY_HUNDREDTHS);
  return round100(Math.floor((lotSqft * factor) / 100));
}

/** grass = round100(max(0, parcel - footprint) x coverage). */
export function grassFromParcel(
  parcelSqft: number,
  footprintSqft: number | null,
  coverageHundredths: number,
): GrassEstimate {
  // R21: the lot size is a tax record, not a measurement of ours.
  const source = "Lot size is from county tax records, not a survey.";
  if (footprintSqft === null) {
    return { grassSqft: wholeLot(parcelSqft, coverageHundredths), assumptions: [source, "Includes the house footprint."] };
  }
  const open = Math.max(0, parcelSqft - footprintSqft);
  return {
    grassSqft: round100(Math.floor((open * coverageHundredths) / 100)),
    assumptions: [source, "Buildings on the lot are left out of the lawn area."],
  };
}

/**
 * The area a homeowner gives, counted in full whichever way they gave it: an
 * outline, a lot size, or a typed figure. No coverage factor applies to any
 * of them; that belongs to the retired parcel formula above.
 */
export function grassFromManual(size: ManualSize): GrassEstimate & { origin: "bucket" | "manual" | "drawn" } {
  if (size.kind === "drawn") {
    return { grassSqft: round100(size.sqft), origin: "drawn", assumptions: ["Measured on an aerial photo, not a survey."] };
  }
  if (size.kind === "bucket") {
    return {
      // The whole lot the homeowner chose is counted: no share is taken off for the house or the drive.
      grassSqft: round100(BUCKET_LOT_SQFT[size.bucket]),
      origin: "bucket",
      assumptions: ["Based on the lot size you chose.", "Counts the whole lot, house and driveway included."],
    };
  }
  return { grassSqft: round100(size.sqft), origin: "manual", assumptions: ["Based on the lawn area you entered."] };
}

/** The homeowner's one adjustment: x0.75 or x1.25. */
export function adjustGrass(grassSqft: number, adjust: "smaller" | "larger"): number {
  return round100(Math.floor((grassSqft * (adjust === "smaller" ? 75 : 125)) / 100));
}

/** The parcel_cache key: lower case, punctuation dropped, single spaces. */
export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The zip in a typed address, if it has one: the last five-digit group, as
 * long as it is not the leading house number.
 */
export function zipFromAddress(address: string): string | null {
  const matches = [...address.matchAll(/(?<![0-9])([0-9]{5})(?:-[0-9]{4})?(?![0-9])/g)];
  const last = matches.at(-1);
  if (!last || address.slice(0, last.index).trim() === "") return null;
  return last[1]!;
}
