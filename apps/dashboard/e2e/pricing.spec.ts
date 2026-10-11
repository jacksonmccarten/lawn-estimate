// Pricing: lawn-size categories, each with one flat rate, for lawn mowing.
// Against the mock, whose published versions 1 and 2 are from before flat
// rates (some tiers per 1,000 sq ft, more than one service).

import type { Page } from "@playwright/test";
import { V2, expect, expectAccessible, signIn, test } from "./support";

const rows = (page: Page) => page.locator('[aria-label="Lawn size categories table"] tbody tr');
const upTo = (page: Page, n: number) => page.getByLabel(`Category ${n}, up to and including, in square feet`);
const rate = (page: Page, n: number) => page.getByLabel(`Category ${n}, flat rate in dollars`);

async function newDraft(page: Page, from = 2) {
  await signIn(page, "/pricing");
  await page.getByRole("button", { name: `New draft from version ${from}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: /^Version \d+, draft$/ })).toBeFocused();
}

/** Fills version 2's mowing categories with flat rates, saves and publishes them as version 3. */
async function publishFlat(page: Page) {
  await newDraft(page);
  await rate(page, 2).fill("60");
  await rate(page, 3).fill("75");
  await page.getByRole("button", { name: /Review and publish/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Publish version 3" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Version 3 is published." })).toBeVisible();
}

test("the version list names the current version in words", async ({ page }) => {
  await signIn(page, "/pricing");
  const table = page.getByRole("table");
  await expect(table.getByRole("row", { name: /Version 2/ })).toContainText("Current");
  await expect(table.getByRole("row", { name: /Version 1/ })).toContainText("Previous");
  await expect(table.getByRole("button", { name: "Roll back to version 1" })).toBeVisible();
  await expect(table.getByRole("button", { name: /Roll back to version 2/ })).toHaveCount(0);
  await expectAccessible(page);
});

test("a published version is read-only and lists its lawn size categories", async ({ page }) => {
  await signIn(page, `/pricing/${V2}`);
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(page.getByText("A published version can’t be edited")).toBeVisible();
  const table = page.getByRole("table", { name: "Lawn size categories" });
  await expect(table.getByRole("row", { name: /0–5,000 sq ft/ })).toContainText("$45.00 flat");
  await expect(table.getByRole("row", { name: /5,001–10,000 sq ft/ })).toContainText("$7.50 per 1,000 sq ft");
  // Nothing to preview, import or add a service with.
  await expect(page.getByRole("button", { name: "Preview quote" })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Services" })).toHaveCount(0);
  await expectAccessible(page);
});

test("a draft has only flat-rate categories, no services, method, CSV or preview", async ({ page }) => {
  await newDraft(page);
  await expectAccessible(page);
  await expect(page.getByRole("heading", { level: 2, name: "Lawn mowing prices" })).toBeVisible();
  await expect(page.getByRole("columnheader")).toHaveText(["Lawn size category", "Up to, sq ft", "Flat rate, $", "Actions"]);
  for (const gone of ["Add service", "Add tier", "Preview quote"]) await expect(page.getByRole("button", { name: gone })).toHaveCount(0);
  await expect(page.getByLabel("CSV file of tiers")).toHaveCount(0);
  await expect(page.getByLabel("Minimum charge, in dollars")).toHaveCount(0);
  await expect(page.getByText("Per 1,000 sq ft")).toHaveCount(0);

  // Version 2's mowing tiers in one region group, in order; the per-square-foot ones need a flat rate.
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).locator("th")).toHaveText(["0–5,000 sq ft", "5,001–10,000 sq ft", "10,001+ sq ft"]);
  await expect(rate(page, 1)).toHaveValue("45.00");
  await expect(rate(page, 2)).toHaveValue("");
  // The last category has no upper bound.
  await expect(upTo(page, 3)).toHaveCount(0);
});

test("draft, validate, save, then publish in two steps with a diff", async ({ page }) => {
  await newDraft(page);
  await expect(page).toHaveTitle(/^Version 3, draft/);

  // Two mistakes: saving is refused, with a focused summary that links to each field.
  await upTo(page, 2).fill("4000");
  await page.getByRole("button", { name: "Save draft" }).click();
  const summary = page.getByRole("alert").filter({ hasText: "The draft has 3 problems" });
  await expect(summary).toBeFocused();
  await expect(upTo(page, 2)).toHaveAccessibleDescription(/Must be more than 5,000, where the category above ends/);
  await expect(rate(page, 2)).toHaveAccessibleDescription(/Enter a dollar amount, such as 45.00/);
  await expectAccessible(page);
  await summary.getByRole("link", { name: /Category 2, up to/ }).click();
  await expect(upTo(page, 2)).toBeFocused();

  await upTo(page, 2).fill("10000");
  await rate(page, 2).fill("60");
  await rate(page, 3).fill("75");
  await expect(page.getByText("You have unsaved changes.")).toBeVisible();

  // The same flat rates are written for every region group the company has.
  const saved = page.waitForRequest((request) => request.method() === "PUT" && /\/pricing-versions\//.test(request.url()));
  await page.getByRole("button", { name: "Save draft" }).click();
  const body = (await saved).postDataJSON() as { minChargeCents: number; services: { code: string }[]; tiers: { regionGroup: string; minSqft: number; maxSqft: number; flatPriceCents: number | null; pricePerSqftMicrocents: number | null }[] };
  expect(body.minChargeCents).toBe(0);
  expect(body.services.map((s) => s.code)).toEqual(["mow"]);
  expect(body.tiers.every((t) => t.pricePerSqftMicrocents === null)).toBe(true);
  expect(body.tiers.filter((t) => t.regionGroup === "core").map((t) => [t.minSqft, t.flatPriceCents])).toEqual([[0, 4500], [5000, 6000], [10000, 7500]]);
  expect(body.tiers.filter((t) => t.regionGroup === "outer")).toHaveLength(3);
  await expect(page.getByRole("status").filter({ hasText: /Draft saved at/ })).toBeVisible();

  // Step 1: the diff against the version in force.
  await page.getByRole("button", { name: /Review and publish/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Step 1 of 2: review changes in version 3" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Publish/ })).toHaveCount(0);
  await expectAccessible(page, { reflow: false });

  // Step 2: an explicit confirmation; going back is possible.
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("heading", { name: "Step 2 of 2: publish version 3?" })).toBeFocused();
  await dialog.getByRole("button", { name: "Back to changes" }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Publish version 3" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Version 3 is published." })).toBeFocused();
  await expect(page.getByRole("heading", { level: 1, name: "Version 3" })).toBeVisible();
  const table = page.getByRole("table", { name: "Lawn size categories" });
  await expect(table.getByRole("row", { name: /10,001\+ sq ft/ })).toContainText("$75.00 flat");

  await page.getByRole("link", { name: "Back to all versions" }).click();
  await expect(page.getByRole("row", { name: /Version 3/ })).toContainText("Current");
});

test("cancelling at either step publishes nothing", async ({ page }) => {
  await newDraft(page);
  await rate(page, 2).fill("60");
  await rate(page, 3).fill("75");
  await page.getByRole("button", { name: /Review and publish/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: /Review and publish/ })).toBeFocused();
  await page.goto("/pricing");
  await expect(page.getByRole("row", { name: /Version 3/ })).toContainText("Draft");
  await expect(page.getByRole("row", { name: /Version 2/ })).toContainText("Current");
});

test("a draft identical to the published version cannot be published", async ({ page }) => {
  await publishFlat(page);
  await page.getByRole("button", { name: "New draft from version 3" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Version 4, draft" })).toBeFocused();
  await page.getByRole("button", { name: /Review and publish/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("there is nothing to publish");
  await expect(dialog.getByRole("button", { name: "Continue" })).toHaveCount(0);
});

test("categories are added above the last and removed, and focus survives", async ({ page }) => {
  await newDraft(page);
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(rows(page)).toHaveCount(4);
  // The new one goes before the open-ended last category, starting where the one before ends.
  await expect(upTo(page, 3)).toBeFocused();
  await expect(upTo(page, 3)).toHaveValue("12500");
  await expect(rows(page).locator("th")).toHaveText(["0–5,000 sq ft", "5,001–10,000 sq ft", "10,001–12,500 sq ft", "12,501+ sq ft"]);

  await page.getByRole("button", { name: "Remove category 3" }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Add category" })).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Category 3 removed." })).toHaveCount(1);
});

test("rollback re-publishes an earlier version through the same review", async ({ page }) => {
  await signIn(page, "/pricing");
  await page.getByRole("button", { name: "Roll back to version 1" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Roll back to version 1?" });
  await expect(confirm).toContainText("nothing changes for homeowners until you publish");
  await expectAccessible(page, { reflow: false });
  await confirm.getByRole("button", { name: "Continue to review" }).click();

  // A draft copied from version 1, opened straight on the diff against version 2.
  await expect(page).toHaveURL(/\/pricing\/[0-9a-f-]+\?review=1$/);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Step 1 of 2: review changes in version 3" })).toBeVisible();
  await expect(dialog.getByText("Minimum charge:")).toContainText("$45.00 becomes  → $40.00");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Publish version 3" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Version 3 is published." })).toBeVisible();
  // Version 1's prices are in force again, as version 3.
  await expect(page.getByRole("table", { name: "Lawn size categories" }).getByRole("row", { name: /0–5,000 sq ft/ })).toContainText("$40.00 flat");
  await page.goto("/pricing");
  await expect(page.getByRole("row", { name: /Version 3/ })).toContainText("Current");
});
