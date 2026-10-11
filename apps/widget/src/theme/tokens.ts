// The widget's fixed palette. src/styles/widget.css declares the same values
// as custom properties; test/theme.test.ts fails if the two drift apart or if
// a pairing listed below drops under its WCAG ratio.

export const tokens = {
  surface: "#ffffff",
  surfaceMuted: "#f3f5f2",
  ink: "#1b1f1d",
  inkMuted: "#4c5751",
  /** Borders of controls: 3:1 against the surface (WCAG 1.4.11). */
  border: "#7d8781",
  /** Dividers that carry no meaning on their own. */
  borderSubtle: "#d8ddd9",
  focus: "#0b57d0",
  danger: "#a5261c",
  dangerSurface: "#fdeeec",
  /** The button color when a company has none, or its own cannot be used. */
  action: "#1d5c3c",
  actionText: "#ffffff",
} as const;

export type TokenName = keyof typeof tokens;

/** Every text-on-background pairing the stylesheet uses: 4.5:1. */
export const textPairs: [TokenName, TokenName][] = [
  ["ink", "surface"],
  ["ink", "surfaceMuted"],
  ["inkMuted", "surface"],
  ["inkMuted", "surfaceMuted"],
  ["danger", "surface"],
  ["danger", "dangerSurface"],
  ["ink", "dangerSurface"],
  ["actionText", "action"],
  ["action", "surface"],
];

/** Boundaries of controls and focus indicators: 3:1. */
export const nonTextPairs: [TokenName, TokenName][] = [
  ["border", "surface"],
  ["border", "surfaceMuted"],
  ["focus", "surface"],
  ["focus", "surfaceMuted"],
  ["action", "surface"],
  ["ink", "surface"],
];

/** `surfaceMuted` -> `--lq-surface-muted`. */
export function cssVarName(name: string): string {
  return "--lq-" + name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}
