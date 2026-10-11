import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultBrand, resolveBrand } from "../src/theme/brand";
import { contrastRatio } from "../src/theme/contrast";
import { cssVarName, nonTextPairs, textPairs, tokens } from "../src/theme/tokens";

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    // The well-known boundary: #767676 is the lightest gray that passes on white.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("rejects anything that is not #rrggbb", () => {
    expect(() => contrastRatio("red", "#ffffff")).toThrow();
    expect(() => contrastRatio("#fff", "#ffffff")).toThrow();
  });
});

describe("design tokens", () => {
  it.each(textPairs)("%s on %s reads at 4.5:1", (text, background) => {
    expect(contrastRatio(tokens[text], tokens[background])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(nonTextPairs)("%s against %s is visible at 3:1", (mark, background) => {
    expect(contrastRatio(tokens[mark], tokens[background])).toBeGreaterThanOrEqual(3);
  });

  it("are the values the stylesheet declares", () => {
    const css = readFileSync(new URL("../src/styles/widget.css", import.meta.url), "utf8");
    for (const [name, value] of Object.entries(tokens)) {
      expect(css, name).toContain(`${cssVarName(name)}: ${value};`);
    }
  });
});

describe("resolveBrand", () => {
  it("uses the fixed palette when there is no color, or not a hex color", () => {
    expect(resolveBrand(null)).toEqual(defaultBrand);
    expect(resolveBrand(undefined)).toEqual(defaultBrand);
    expect(resolveBrand("red")).toEqual(defaultBrand);
    expect(resolveBrand("#fff")).toEqual(defaultBrand);
    expect(resolveBrand("#1f6f43; background: url(//evil.example)")).toEqual(defaultBrand);
  });

  it("fills buttons with a dark brand color, under white text", () => {
    expect(resolveBrand("#1F6F43")).toEqual({
      buttonBg: "#1f6f43",
      buttonText: "#ffffff",
      buttonBorder: "#1f6f43",
      accent: "#1f6f43",
    });
  });

  it("puts dark text and a dark border on a light brand color, and keeps it out of the accent", () => {
    expect(resolveBrand("#ffd200")).toEqual({
      buttonBg: "#ffd200",
      buttonText: tokens.ink,
      buttonBorder: tokens.ink,
      accent: tokens.border,
    });
  });

  it("keeps a mid-tone that no fixed text color reads on off the buttons", () => {
    // 4.48:1 with white and less with the ink: not enough either way.
    const theme = resolveBrand("#777777");
    expect(theme.buttonBg).toBe(tokens.action);
    expect(theme.buttonText).toBe(tokens.actionText);
    expect(theme.accent).toBe("#777777");
  });

  it("never yields a button whose text is under 4.5:1 or whose edge is under 3:1", () => {
    for (let n = 0; n <= 0xffffff; n += 0x030507) {
      const theme = resolveBrand("#" + n.toString(16).padStart(6, "0"));
      expect(contrastRatio(theme.buttonBg, theme.buttonText)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.buttonBorder, tokens.surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(theme.accent, tokens.surface)).toBeGreaterThanOrEqual(3);
    }
  });
});
