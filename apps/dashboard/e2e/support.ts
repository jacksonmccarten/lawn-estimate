import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "@playwright/test";

export const OWNER_EMAIL = "owner@nittanylawn.example";
export const TOTP = "123456";

// The seeded company's versions (src/mock/store.ts).
export const V1 = "00000000-0000-4000-8000-000100000001";
export const V2 = "00000000-0000-4000-8000-000100000002";
/** Seed lead 1: the newest, status submitted. */
export const NEW_LEAD = "00000000-0000-4000-8000-000200000001";
/** Seed lead 4: accepted at the operator's own total. */
export const DECIDED_LEAD = "00000000-0000-4000-8000-000200000004";

export const test = base.extend({
  // Every test starts from the seeded company.
  page: async ({ page, request }, use) => {
    expect((await request.post("/mock-api/__reset")).status()).toBe(204);
    await use(page);
  },
});
export { expect };

export async function signIn(page: Page, path = "/leads") {
  await page.goto(path);
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill("any password");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("6-digit code").fill(TOTP);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/** Picks an option in a React Aria select, by the select's label. */
export async function choose(page: Page, label: string | RegExp, option: string) {
  await page.getByRole("button", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** React Aria radios and checkboxes are a label around a visually hidden input: click the label, as a person would. */
export async function pick(page: Page, name: string | RegExp) {
  await page.locator("label.radio, label.checkbox").filter({ hasText: name }).click();
}

/**
 * axe on the page as it stands, in both color schemes, plus the reflow rule:
 * at 320 CSS px the page itself must not scroll sideways (1.4.10).
 */
export async function expectAccessible(page: Page, { reflow = true }: { reflow?: boolean } = {}) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    const found = results.violations.map((v) => `${colorScheme} ${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
    expect(found).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
  if (!reflow) return;
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 640 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the page scrolls sideways at 320px").toBeLessThanOrEqual(0);
  await page.setViewportSize(size);
}
