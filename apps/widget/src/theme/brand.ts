// Where a company's brand color may go (docs/ENGINEERING_DESIGN.md section 11,
// R25). The company sets one color and never a text color. The color fills
// buttons only if a fixed text color reads on it at 4.5:1; otherwise buttons
// use the fixed palette and the color is at most an accent.

import { contrastRatio, HEX_COLOR } from "./contrast";
import { tokens } from "./tokens";

export type BrandTheme = {
  buttonBg: string;
  buttonText: string;
  /** Differs from the fill when the fill alone would not stand out from the page. */
  buttonBorder: string;
  /** The rule under the header and the marker on a pressed chip. Never text. */
  accent: string;
};

const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;

export const defaultBrand: BrandTheme = {
  buttonBg: tokens.action,
  buttonText: tokens.actionText,
  buttonBorder: tokens.action,
  accent: tokens.action,
};

export function resolveBrand(color: string | null | undefined): BrandTheme {
  if (!color || !HEX_COLOR.test(color)) return defaultBrand;
  const brand = color.toLowerCase();

  const standsOut = contrastRatio(brand, tokens.surface) >= NON_TEXT_MIN;
  const accent = standsOut ? brand : tokens.border;

  const buttonText = [tokens.actionText, tokens.ink].find((text) => contrastRatio(brand, text) >= TEXT_MIN);
  if (!buttonText) return { ...defaultBrand, accent };

  return { buttonBg: brand, buttonText, buttonBorder: standsOut ? brand : tokens.ink, accent };
}

/** The custom properties the stylesheet reads. Values are validated hex colors. */
export function brandCssVars(theme: BrandTheme): Record<string, string> {
  return {
    "--lq-btn-bg": theme.buttonBg,
    "--lq-btn-text": theme.buttonText,
    "--lq-btn-border": theme.buttonBorder,
    "--lq-accent": theme.accent,
  };
}
