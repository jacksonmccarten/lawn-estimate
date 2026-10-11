// Creating an account: sign up, prove the address with the emailed code,
// name the company, and land on pricing. Against the mock, whose code is
// fixed; no email is sent.

import { OWNER_EMAIL, expect, expectAccessible, test } from "./support";

const NEW_EMAIL = "new.owner@example.com";
const PASSWORD = "Correct-Horse-9";
const CODE = "123456";

test("a new owner signs up, verifies their email, names their company and reaches their service area", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  await expect(page).toHaveTitle(/^Create an account/);
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("Password")).toHaveAttribute("autocomplete", "new-password");
  await expectAccessible(page);

  await page.getByLabel("Email").fill(NEW_EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();

  // The second step takes focus and says where the code went.
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
  await expect(page.getByText(NEW_EMAIL)).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await expect(page.getByLabel("6-digit code")).toHaveAttribute("autocomplete", "one-time-code");
  await expectAccessible(page);

  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText("That code isn’t right, or it has expired.")).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByRole("status").filter({ hasText: "We sent a new code" })).toBeVisible();

  await page.getByLabel("6-digit code").fill(CODE);
  await page.getByRole("button", { name: "Verify email" }).click();

  // Verified and signed in, with no company yet.
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { level: 1, name: "Set up your company" })).toBeVisible();
  await expect(page.getByText(NEW_EMAIL)).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByText("Enter your company’s name.")).toBeVisible();
  await expect(page.getByLabel("Company name")).toBeFocused();
  await expectAccessible(page);

  await page.getByLabel("Company name").fill("Happy Valley Mowing");
  await page.getByRole("button", { name: "Create company" }).click();
  // A new account starts at its service area: where it works, then what it charges.
  await expect(page).toHaveURL(/\/settings\/area$/);
  await expect(page.getByRole("heading", { level: 1, name: "Service area" })).toBeVisible();
  await expect(page.locator(".brand-company")).toHaveText("Happy Valley Mowing");

  // The setup screen is behind them: going back to it leads on to the app.
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/leads$/);
});

test("sign-up says what is wrong with an email or a password, at the field", async ({ page }) => {
  await page.goto("/sign-up");

  await page.getByLabel("Email").fill("not-an-address");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Enter an email address like name@example.com.")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeFocused();
  await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");

  await page.getByLabel("Email").fill(NEW_EMAIL);
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeFocused();

  await page.getByLabel("Password").fill("alllowercaseletters");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Include a capital letter, a small letter and a number.")).toBeVisible();
  await expectAccessible(page);

  // An address that already has an account.
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("An account with this email already exists. Sign in instead.")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeFocused();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
});

test("a visitor who is not signed in cannot reach company setup", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fonboarding/);
});

test("a new company's first draft has a service to price and its region group already chosen", async ({ page }) => {
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill("first.draft@example.com");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByLabel("6-digit code").fill(CODE);
  await page.getByRole("button", { name: "Verify email" }).click();
  await page.getByLabel("Company name").fill("First Draft Lawns");
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page).toHaveURL(/\/settings\/area$/);

  // The mock company has versions already; a draft from nothing is what a new company starts with.
  const created = await page.evaluate(async () => {
    const session = JSON.parse(sessionStorage.getItem("lq.session")!) as { token: string };
    const res = await fetch("/mock-api/pricing-versions", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    return (await res.json()) as { id: string };
  });
  await page.goto(`/pricing/${created.id}`);
  await expect(page.getByRole("heading", { level: 2, name: "Tiers", exact: true })).toBeVisible();
  // What a region group is, and which ones this company has.
  await expect(page.getByText(/A region group is a part of your service area that shares one set of prices/)).toBeVisible();
  await expect(page.getByText("Yours are: core, outer.")).toBeVisible();

  // Mowing is there from the start, so the first tier has a service, and its region group is a choice, not a blank.
  await page.getByRole("button", { name: "Add tier" }).click();
  await expect(page.getByRole("button", { name: /Tier 1, service/ })).toContainText("Mowing, trimming and edging");
  await expect(page.getByRole("button", { name: /Tier 1, region group/ })).toContainText("core");
  await page.getByRole("button", { name: /Tier 1, region group/ }).click();
  await expect(page.getByRole("option")).toHaveText(["core", "outer"]);
  await page.keyboard.press("Escape");
  await expectAccessible(page);
});
