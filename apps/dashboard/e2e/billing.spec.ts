import { expect, expectAccessible, signIn, test } from "./support";

test("billing: this month's estimates, and the hosted plan pages", async ({ page }) => {
  // The mock's links lead nowhere real; stop the browser there and see where it was sent.
  const opened: string[] = [];
  await page.route("https://billing.mock.invalid/**", (route) => {
    opened.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Hosted billing</title><p>Hosted billing</p>" });
  });

  await signIn(page, "/billing");
  await expect(page).toHaveTitle(/^Billing/);
  await expect(page.getByRole("link", { name: "Billing" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("187 estimates priced in October 2026.")).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "See plans and prices" }).click();
  await expect(page).toHaveURL("https://billing.mock.invalid/plans");

  await page.goBack();
  await page.getByRole("button", { name: "Manage subscription and invoices" }).click();
  await expect(page).toHaveURL("https://billing.mock.invalid/portal");
  expect(opened).toEqual(["https://billing.mock.invalid/plans", "https://billing.mock.invalid/portal"]);
});

test("billing: says so when the billing pages can't be opened", async ({ page }) => {
  await page.route("**/mock-api/billing/session", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "billing_unavailable", message: "down" } }) }),
  );
  await signIn(page, "/billing");
  await page.getByRole("button", { name: "See plans and prices" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Billing isn’t available right now. Try again in a few minutes." })).toBeVisible();
  await expectAccessible(page);
});
