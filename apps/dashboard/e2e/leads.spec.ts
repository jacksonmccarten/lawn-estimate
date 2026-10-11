import { DECIDED_LEAD, NEW_LEAD, expect, expectAccessible, pick, signIn, test } from "./support";

test("the inbox is a real table that sorts, filters and pages", async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveTitle(/^Leads/);
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(26);
  await expect(page.getByRole("status").filter({ hasText: "Page 1" })).toContainText("25 leads");
  await expectAccessible(page);

  // Sortable headers are buttons, and the header says which way it is sorted.
  const received = table.getByRole("columnheader", { name: "Received" });
  await expect(received).toHaveAttribute("aria-sort", "descending");
  const total = table.getByRole("columnheader", { name: "Total" });
  await expect(total).not.toHaveAttribute("aria-sort");
  await total.getByRole("button").click();
  await expect(total).toHaveAttribute("aria-sort", "ascending");
  const amounts = await table.locator("tbody td.num").allTextContents();
  const cents = amounts.map((text) => Number(text.replace(/[^0-9.]/g, "")));
  expect(cents).toEqual([...cents].sort((a, b) => a - b));
  await total.getByRole("button").press("Enter");
  await expect(total).toHaveAttribute("aria-sort", "descending");

  // Pagination is links, with the current page marked.
  await page.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/trail=o25/);
  await expect(page.getByRole("navigation", { name: "Pagination" }).locator("[aria-current=page]")).toHaveText("Page 2");
  await expect(table.getByRole("row")).toHaveCount(8);
  await expectAccessible(page);
  await page.getByRole("link", { name: "Previous page" }).click();
  await expect(table.getByRole("row")).toHaveCount(26);

  // Status is text plus a shape, never color alone.
  await page.getByRole("navigation", { name: "Filter leads by status" }).getByRole("link", { name: "Declined" }).click();
  await expect(page).toHaveURL(/status=declined/);
  const chips = table.locator("tbody .chip");
  await expect(chips.first()).toHaveText("Declined");
  await expect(chips.first().locator("svg")).toHaveCount(1);
  expect(new Set(await chips.allTextContents())).toEqual(new Set(["Declined"]));
  await expectAccessible(page);
});

test("row actions are reachable with Tab and open the lead", async ({ page }) => {
  await signIn(page);
  const firstReview = page.getByRole("table").getByRole("link", { name: /^Review lead from/ }).first();
  await firstReview.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/leads/${NEW_LEAD}$`));
  // On a route change focus moves to the new page's heading and the title follows.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(page).toHaveTitle(/^Lead from Avery Kline/);
});

test("a lead shows taxable and non-taxable lines apart, with the tax county", async ({ page }) => {
  await signIn(page, `/leads/${NEW_LEAD}`);
  const lines = page.getByRole("table", { name: "Line items" });
  await expect(lines.getByRole("row", { name: /Mowing, trimming and edging/ })).toContainText("Taxable");
  await expect(lines.getByRole("row", { name: /Leaf raking/ })).toContainText("Not taxable");
  await expect(lines.getByRole("row", { name: /Sales tax, Centre County, 6%/ })).toBeVisible();
  await expect(page.getByText("An estimate, not a contract.")).toBeVisible();
  await expectAccessible(page);
});

test("accepting a lead at the estimate needs a confirmation and is final", async ({ page }) => {
  await signIn(page, `/leads/${NEW_LEAD}`);

  // Nothing chosen: the problem is stated, not just refused.
  await page.getByRole("button", { name: "Review decision" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Choose what to do with this lead" })).toBeVisible();

  await pick(page, /Accept at the estimate/);
  await page.getByRole("button", { name: "Review decision" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("A lead is decided once");
  await expectAccessible(page, { reflow: false });

  // Escape closes without deciding and focus returns to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Review decision" })).toBeFocused();

  await page.getByRole("button", { name: "Review decision" }).click();
  await dialog.getByRole("button", { name: "Accept lead" }).click();
  const result = page.getByRole("status").filter({ hasText: "You accepted this lead." });
  await expect(result).toBeFocused();
  await expect(page.getByText("This lead was accepted. A decision can’t be changed.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review decision" })).toHaveCount(0);
  await expectAccessible(page);
});

test("accepting at a different total validates the amount", async ({ page }) => {
  await signIn(page, `/leads/${NEW_LEAD}`);
  await pick(page, "Accept at a different total");
  const total = page.getByLabel(/^Your total, in dollars/);
  await total.fill("about sixty");
  await page.getByRole("button", { name: "Review decision" }).click();
  await expect(total).toBeFocused();
  await expect(total).toHaveAttribute("aria-invalid", "true");
  await expect(total).toHaveAccessibleDescription(/Enter a dollar amount/);

  await total.fill("185.50");
  await page.getByRole("button", { name: "Review decision" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("your total of $185.50");
  await page.getByRole("alertdialog").getByRole("button", { name: "Accept lead" }).click();
  await expect(page.getByText("at your total of $185.50")).toBeVisible();
});

test("declining a lead", async ({ page }) => {
  await signIn(page, `/leads/${NEW_LEAD}`);
  await pick(page, "Decline");
  await page.getByRole("button", { name: "Review decision" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Decline lead" }).click();
  await expect(page.getByRole("status").filter({ hasText: "You declined this lead." })).toBeVisible();
  await page.goto("/leads?status=declined");
  await expect(page.getByRole("table").getByRole("row").nth(1)).toContainText("Avery Kline");
});

test("a lead someone else decided first is not decided again", async ({ page }) => {
  await signIn(page, `/leads/${NEW_LEAD}`);
  await pick(page, "Decline");

  // Another operator accepts it while this one is still looking.
  const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem("lq.session")!).token as string);
  const other = await page.request.post(`/mock-api/leads/${NEW_LEAD}/decision`, { headers: { Authorization: `Bearer ${token}` }, data: { action: "accept" } });
  expect(other.status()).toBe(200);

  await page.getByRole("button", { name: "Review decision" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Decline lead" }).click();
  await expect(page.getByRole("status").filter({ hasText: "already decided" })).toBeVisible();
  await expect(page.getByText("This lead was accepted. A decision can’t be changed.")).toBeVisible();
});

test("a decided lead offers no decision", async ({ page }) => {
  await signIn(page, `/leads/${DECIDED_LEAD}`);
  await expect(page.getByText(/at your total of/)).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expectAccessible(page);
});

test("a missing lead says so and offers a retry", async ({ page }) => {
  await signIn(page, "/leads/00000000-0000-4000-8000-000299999999");
  await expect(page.getByRole("alert").filter({ hasText: "couldn’t find that" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expectAccessible(page);
});
