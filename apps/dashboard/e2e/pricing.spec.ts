import type { Page } from "@playwright/test";
import { V2, choose, expect, expectAccessible, pick, signIn, test } from "./support";

const tierRows = (page: Page) => page.locator('[aria-label="Tiers table"] tbody tr');
const csv = (name: string, lines: string[]) => ({ name, mimeType: "text/csv", buffer: Buffer.from(lines.join("\r\n")) });
const HEADER = "service_code,region_group,min_sqft,max_sqft,price_per_1000_sqft,flat_price";

async function newDraft(page: Page) {
  await signIn(page, "/pricing");
  await page.getByRole("button", { name: "New draft from version 2" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Version 3, draft" })).toBeFocused();
  await expect(tierRows(page)).toHaveCount(7);
}

async function preview(page: Page, sqft: string, county = "Centre") {
  await choose(page, / Service$/, "Mowing, trimming and edging");
  await page.getByLabel("Lawn area, sq ft").fill(sqft);
  await choose(page, /Region group$/, "core");
  await choose(page, /County, for sales tax$/, county);
  await page.getByRole("button", { name: "Preview quote" }).click();
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

test("a published version is read-only and previews the design's worked example", async ({ page }) => {
  await signIn(page, `/pricing/${V2}`);
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(page.getByText("A published version can’t be edited")).toBeVisible();
  await expectAccessible(page);

  // 6,400 sq ft at $7.50 per 1,000 sq ft is $48.00; Centre County's 6% is $2.88.
  await preview(page, "6400");
  const quote = page.getByRole("table", { name: "Previewed quote" });
  await expect(quote.getByRole("row", { name: /Mowing/ })).toContainText("$48.00");
  await expect(quote.getByRole("row", { name: /Sales tax, Centre County, 6% on \$48.00/ })).toContainText("$2.88");
  await expect(quote.getByRole("row", { name: /Estimated total/ })).toContainText("$50.88");
  await expect(page.getByText("This is an estimate, not a contract.")).toBeVisible();
  await expectAccessible(page);

  // The county sets the rate: Allegheny is 7%.
  await choose(page, /County, for sales tax$/, "Allegheny");
  await page.getByRole("button", { name: "Preview quote" }).click();
  await expect(quote.getByRole("row", { name: /Sales tax, Allegheny County, 7%/ })).toContainText("$3.36");

  // A non-taxable add-on stays its own line and adds no tax.
  await pick(page, "Leaf raking");
  await page.getByRole("button", { name: "Preview quote" }).click();
  await expect(quote.getByRole("row", { name: /Leaf raking/ })).toContainText("Not taxable");
  await expect(quote.getByRole("row", { name: /Sales tax, Allegheny County, 7% on \$48.00/ })).toContainText("$3.36");
  await expect(quote.getByRole("row", { name: /Estimated total/ })).toContainText("$171.36");

  // No tier for the size: no price, and why.
  await page.getByLabel("Lawn area, sq ft").fill("90000");
  await page.getByRole("button", { name: "Preview quote" }).click();
  await expect(page.getByText(/No tier covers 90,000 sq ft/)).toBeVisible();
});

test("preview form errors are tied to their fields", async ({ page }) => {
  await signIn(page, `/pricing/${V2}`);
  await page.getByRole("button", { name: "Preview quote" }).click();
  await expect(page.getByRole("button", { name: / Service$/ })).toBeFocused();
  await expect(page.getByLabel("Lawn area, sq ft")).toHaveAccessibleDescription(/Enter a whole number/);
  await expectAccessible(page);
});

test("draft, validate, save, preview, then publish in two steps with a diff", async ({ page }) => {
  await newDraft(page);
  await expect(page).toHaveTitle(/^Version 3, draft/);
  await expectAccessible(page);

  // Labels carry their units.
  await expect(page.getByRole("columnheader", { name: "Price, $ per 1,000 sq ft or $ flat" })).toBeVisible();
  const minCharge = page.getByLabel("Minimum charge, in dollars");
  const tier1Max = page.getByLabel("Tier 1, lawn area up to and including, in square feet");

  // Two mistakes: saving is refused, with a focused summary that links to each field.
  await minCharge.fill("fifty");
  await tier1Max.fill("0");
  await page.getByRole("button", { name: "Save draft" }).click();
  const summary = page.getByRole("alert").filter({ hasText: "The draft has 2 problems" });
  await expect(summary).toBeFocused();
  await expect(minCharge).toHaveAttribute("aria-invalid", "true");
  await expect(minCharge).toHaveAccessibleDescription(/Enter a dollar amount, such as 45.00/);
  await expect(tier1Max).toHaveAccessibleDescription(/Must be greater than/);
  await expectAccessible(page);
  await summary.getByRole("link", { name: /Tier 1, up to/ }).click();
  await expect(tier1Max).toBeFocused();

  await tier1Max.fill("5000");
  await minCharge.fill("50");
  await page.getByLabel("Tier 2, price in dollars per 1,000 square feet").fill("8.00");
  await expect(page.getByText("You have unsaved changes.")).toBeVisible();

  // Previewing a draft saves it first, then prices it server-side.
  await preview(page, "6400");
  const quote = page.getByRole("table", { name: "Previewed quote" });
  await expect(quote.getByRole("row", { name: /Mowing/ })).toContainText("$51.20");
  await expect(quote.getByRole("row", { name: /Estimated total/ })).toContainText("$54.27");
  await expect(page.getByRole("status").filter({ hasText: /Draft saved at/ })).toBeVisible();

  // The minimum charge applies to a small lawn.
  await page.getByLabel("Lawn area, sq ft").fill("1000");
  await page.getByRole("button", { name: "Preview quote" }).click();
  await expect(quote.getByRole("row", { name: /Mowing/ })).toContainText("$50.00");

  // Step 1: the diff against the version in force.
  await page.getByRole("button", { name: /Review and publish/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Step 1 of 2: review changes in version 3" })).toBeVisible();
  await expect(dialog.getByText("Minimum charge:")).toContainText("$45.00 becomes  → $50.00");
  await expect(dialog.getByText(/mow, core, over 5,000 sq ft, up to 10,000 sq ft/)).toContainText("$7.50 per 1,000 sq ft becomes  → $8.00 per 1,000 sq ft");
  await expect(dialog.getByRole("button", { name: /^Publish/ })).toHaveCount(0);
  await expectAccessible(page, { reflow: false });

  // Step 2: an explicit confirmation; going back is possible.
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("heading", { name: "Step 2 of 2: publish version 3?" })).toBeFocused();
  await expectAccessible(page, { reflow: false });
  await dialog.getByRole("button", { name: "Back to changes" }).click();
  await expect(dialog.getByText("Minimum charge:")).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByRole("button", { name: "Publish version 3" }).click();

  const published = page.getByRole("status").filter({ hasText: "Version 3 is published." });
  await expect(published).toBeFocused();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "Version 3" })).toBeVisible();

  await page.getByRole("link", { name: "Back to all versions" }).click();
  await expect(page.getByRole("row", { name: /Version 3/ })).toContainText("Current");
  await expect(page.getByRole("row", { name: /Version 2/ })).toContainText("Previous");
});

test("cancelling at either step publishes nothing", async ({ page }) => {
  await newDraft(page);
  await page.getByLabel("Minimum charge, in dollars").fill("99");
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
  await newDraft(page);
  await page.getByRole("button", { name: /Review and publish/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("there is nothing to publish");
  await expect(dialog.getByRole("button", { name: "Continue" })).toHaveCount(0);
});

test("a changed tax flag is called out before publishing", async ({ page }) => {
  await newDraft(page);
  await choose(page, /Service 3, sales tax$/, "Taxable");
  await page.getByRole("button", { name: /Review and publish/ }).click();
  await expect(page.getByRole("dialog")).toContainText("sales tax not taxable becomes  → taxable, which changes what homeowners are charged");
});

test("a new service has no default tax treatment", async ({ page }) => {
  await newDraft(page);
  await page.getByRole("button", { name: "Add service" }).click();
  const name = page.getByLabel("Service 4, name");
  await expect(name).toBeFocused();
  await name.fill("Dethatching");
  await page.getByLabel("Service 4, code").fill("dethatch");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The draft has 1 problem" })).toContainText("Service 4, sales tax: Choose whether sales tax applies");
  await choose(page, /Service 4, sales tax$/, "Taxable");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Draft saved at/ })).toBeVisible();
});

test("tiers reorder with buttons, and focus survives adding and removing rows", async ({ page }) => {
  await newDraft(page);
  await expect(page.getByLabel("Tier 1, lawn area over, in square feet")).toHaveValue("0");

  const up = page.getByRole("button", { name: "Move tier 2 up" });
  await up.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Tier 1, lawn area over, in square feet")).toHaveValue("5000");
  await expect(page.getByRole("status").filter({ hasText: "Tier moved to position 1 of 7." })).toHaveCount(1);
  // The same row's button keeps focus, now as tier 1; at the top it says so instead of going dead.
  const first = page.getByRole("button", { name: "Move tier 1 up" });
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Tier 1 is already first." })).toHaveCount(1);
  await expect(first).toBeFocused();

  await page.getByRole("button", { name: "Remove tier 7" }).click();
  await expect(tierRows(page)).toHaveCount(6);
  await expect(page.getByRole("button", { name: "Add tier" })).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(tierRows(page)).toHaveCount(7);
  await expect(page.getByRole("button", { name: /Tier 7, service$/ })).toBeFocused();
});

test("overlapping tiers are refused before saving", async ({ page }) => {
  await newDraft(page);
  await page.getByLabel("Tier 2, lawn area over, in square feet").fill("4000");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The draft has 1 problem" })).toContainText("This range overlaps tier 1");
});

test("CSV import replaces tiers, or reports every problem as a table", async ({ page }) => {
  await newDraft(page);
  const file = page.getByLabel("CSV file of tiers");
  await expect(file).toHaveAttribute("type", "file");

  // A file with problems imports nothing.
  await file.setInputFiles(csv("bad.csv", [HEADER, "snow,core,0,5000,,45", "mow,core,x,5000,7.50,45", "mow,core,0,100,,"]));
  const problems = page.locator('[aria-labelledby="csv-problems-heading"]');
  await expect(problems).toBeFocused();
  await expect(problems.getByRole("heading")).toHaveText("4 problems in bad.csv");
  await expect(problems.getByRole("columnheader")).toHaveText(["Row", "Column", "Problem"]);
  await expect(problems.locator("tbody tr").first()).toContainText(["2", "service_code", "No service with the code"].join(""));
  await expect(page.locator("#csv-status")).toContainText("bad.csv was not imported: 4 problems to fix. Nothing in the draft changed.");
  await expect(page.locator("#csv-status")).toHaveAttribute("aria-live", "polite");
  await expect(tierRows(page)).toHaveCount(7);
  await expectAccessible(page);

  // A clean file replaces the draft's tiers on screen; saving keeps them.
  await file.setInputFiles(csv("tiers.csv", [HEADER, "mow,core,0,5000,,49.00", "mow,core,5000,12000,8.25,"]));
  await expect(page.locator("#csv-status")).toContainText("Imported 2 tiers from tiers.csv, replacing the tiers in the draft.");
  await expect(problems).toHaveCount(0);
  await expect(tierRows(page)).toHaveCount(2);
  await expect(page.getByLabel("Tier 2, price in dollars per 1,000 square feet")).toHaveValue("8.25");
  await expect(page.getByLabel("Tier 1, flat price in dollars")).toHaveValue("49.00");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Draft saved at/ })).toBeVisible();
  await page.reload();
  await expect(tierRows(page)).toHaveCount(2);

  // Adding checks the new rows against the tiers already there.
  await pick(page, "Add to the tiers in the draft");
  await file.setInputFiles(csv("more.csv", [HEADER, "mow,core,10000,20000,7.00,"]));
  await expect(problems).toContainText("overlaps tier 2 already in the draft");
  await expect(tierRows(page)).toHaveCount(2);
  await file.setInputFiles(csv("more.csv", [HEADER, "mow,core,12000,20000,7.00,", "aerate,core,0,20000,,90"]));
  await expect(page.locator("#csv-status")).toContainText("Added 2 tiers from more.csv to the draft.");
  await expect(tierRows(page)).toHaveCount(4);
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

  // Version 1's prices are in force again, as version 3; versions 1 and 2 are untouched.
  await preview(page, "6400");
  await expect(page.getByRole("table", { name: "Previewed quote" }).getByRole("row", { name: /Mowing/ })).toContainText("$44.80");
  await page.goto("/pricing");
  await expect(page.getByRole("row", { name: /Version 3/ })).toContainText("Current");
  await expect(page.getByRole("button", { name: "Roll back to version 2" })).toBeVisible();
});
