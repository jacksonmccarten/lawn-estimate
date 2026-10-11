// WCAG 2.x relative luminance and contrast ratio for #rrggbb colors.

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * How the widget will use a company's brand color (design §11): as a button
 * fill only when it reaches 4.5:1 against white or near-black text, otherwise
 * as an accent with text from the fixed palette.
 */
export function brandColorUse(hex: string): { use: "fill"; text: "#ffffff" | "#111111"; ratio: number } | { use: "accent"; ratio: number } {
  const onWhite = contrastRatio(hex, "#ffffff");
  const onDark = contrastRatio(hex, "#111111");
  const [text, ratio] = onWhite >= onDark ? (["#ffffff", onWhite] as const) : (["#111111", onDark] as const);
  return ratio >= 4.5 ? { use: "fill", text, ratio } : { use: "accent", ratio };
}
