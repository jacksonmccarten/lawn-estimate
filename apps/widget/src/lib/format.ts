// Formatting at the edge: money is integer cents and tax rates are basis
// points everywhere else.

export function formatCents(cents: number): string {
  const dollars = Math.trunc(cents / 100).toLocaleString("en-US");
  return `$${dollars}.${String(cents % 100).padStart(2, "0")}`;
}

/** 600 -> "6%", 625 -> "6.25%". */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function formatSqft(sqft: number): string {
  return `${sqft.toLocaleString("en-US")} sq ft`;
}

/** A `tel:` target from a display phone number, or null if it has too few digits to dial. */
export function telHref(phone: string): string | null {
  const digits = phone.replace(/[^0-9+]/g, "");
  return digits.replace(/\+/g, "").length >= 7 ? `tel:${digits}` : null;
}

/** An address as the homeowner types it: one box for each part. */
export type AddressParts = { street: string; city: string; state: string; zip: string };

/** The parts as one line, the way an envelope is addressed: "412 Maple Ave, Lancaster, PA 17601". */
export function formatAddress(parts: AddressParts): string {
  const squeeze = (text: string) => text.trim().replace(/\s+/g, " ");
  return `${squeeze(parts.street)}, ${squeeze(parts.city)}, ${parts.state.trim().toUpperCase()} ${parts.zip.trim()}`;
}
