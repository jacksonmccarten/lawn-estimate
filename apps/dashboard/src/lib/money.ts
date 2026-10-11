// Formatting and parsing at the edge. Everything stored or sent is an integer:
// cents, microcents per square foot, basis points. Parsing works on the digits
// of the text, so no floating-point value ever becomes money.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const whole = new Intl.NumberFormat("en-US");

export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

export function formatSqft(sqft: number): string {
  return `${whole.format(sqft)} sq ft`;
}

/** 600 → "6%", 650 → "6.5%". */
export function formatBps(bps: number): string {
  return `${String(bps / 100)}%`;
}

/** Parses "$1,234.5" style text to an integer scaled by 10^decimals, or null. */
function parseScaled(text: string, decimals: number): number | null {
  const cleaned = text.trim().replace(/^\$\s*/, "").replace(/,/g, "");
  const match = new RegExp(`^(\\d{1,9})(?:\\.(\\d{0,${decimals}}))?$`).exec(cleaned);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  return Number(match[1]) * 10 ** decimals + Number(fraction || "0");
}

function scaledToInput(value: number, decimals: number, minDecimals: number): string {
  const digits = String(value).padStart(decimals + 1, "0");
  const integer = digits.slice(0, -decimals);
  let fraction = digits.slice(-decimals);
  while (fraction.length > minDecimals && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return fraction ? `${integer}.${fraction}` : integer;
}

/** "45", "45.5", "$1,200.00" → cents. Null when it is not a dollar amount. */
export function parseDollars(text: string): number | null {
  return parseScaled(text, 2);
}

/** 4500 → "45.00", for an input's value. */
export function centsToInput(cents: number): string {
  return scaledToInput(cents, 2, 2);
}

// A tier's rate is stored in millionths of a cent per square foot and edited
// in dollars per 1,000 sq ft: $7.50 per 1,000 sq ft is 750,000 microcents per
// sq ft, so one dollar per 1,000 sq ft is 100,000 microcents.
const RATE_DECIMALS = 5;

/** "7.50" ($ per 1,000 sq ft) → microcents per sq ft. */
export function parseRatePer1000(text: string): number | null {
  return parseScaled(text, RATE_DECIMALS);
}

export function rateToInput(microcents: number): string {
  return scaledToInput(microcents, RATE_DECIMALS, 2);
}

export function formatRatePer1000(microcents: number): string {
  return `$${rateToInput(microcents)} per 1,000 sq ft`;
}

/** Digits only, for square feet. */
export function parseWholeNumber(text: string): number | null {
  const cleaned = text.trim().replace(/,/g, "");
  if (!/^\d{1,9}$/.test(cleaned)) return null;
  return Number(cleaned);
}
