// The public website: the homepage is no longer the sign-in, it explains the
// product and leads to sign-up and log-in; About and Contact pages; /login.

import { expect, expectAccessible, OWNER_EMAIL, TOTP, test } from "./support";

// The pages fade in; axe would measure text mid-fade. With reduced motion there is no animation.
test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("the homepage introduces InstaQuoter AI and leads to sign-up and log-in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle("InstaQuoter AI: instant lawn care quotes");
  await expect(page.getByRole("heading", { level: 1, name: "Instant Lawn Care Quotes. More Customers. Less Work." })).toBeVisible();
  await expect(page.getByText(/InstaQuoter AI helps lawn care businesses automate their estimating process/)).toBeVisible();

  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Get Started" }).first()).toHaveAttribute("href", "/sign-up");
  await expect(main.getByRole("link", { name: "Log In" })).toHaveAttribute("href", "/login");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveText(["Home", "About", "Contact"]);
  await expect(page.getByRole("banner").getByRole("link", { name: "Log In" })).toBeVisible();

  // How it works, in four steps, and the benefits.
  await main.getByRole("link", { name: "See How It Works" }).click();
  await expect(page).toHaveURL(/#how-it-works$/);
  const steps = page.getByRole("region", { name: /four steps/ }).getByRole("heading", { level: 3 });
  await expect(steps).toHaveText(["Add InstaQuoter to Your Website", "Customers Measure Their Lawn", "Generate Instant Pricing", "Convert Leads Into Customers"]);
  await expect(page.getByRole("region", { name: "Built for lawn care businesses" }).getByRole("listitem")).toHaveCount(7);
  await expectAccessible(page);
});

test("About and Contact pages, with a phone number that calls", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByText("We are a team of Penn State engineering students passionate about making home services more efficient.")).toBeVisible();
  await expect(page.getByText(/InstaQuoter AI was created to make lawn care estimating faster/)).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Contact" }).click();
  await expect(page).toHaveURL(/\/contact$/);
  await expect(page.getByRole("heading", { level: 2, name: "InstaQuoter AI" })).toBeVisible();
  await expect(page.getByRole("link", { name: "267-405-0260" })).toHaveAttribute("href", "tel:+12674050260");
  await expectAccessible(page);
});

test("Log In opens the existing sign-in at /login, and a signed-in owner goes to the dashboard", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("banner").getByRole("link", { name: "Log In" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill("any password");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("6-digit code").fill(TOTP);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/leads$/);

  // Already signed in: /login goes straight on.
  await page.goto("/login");
  await expect(page).toHaveURL(/\/leads$/);
});
