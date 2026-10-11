import { OWNER_EMAIL, TOTP, V2, expect, expectAccessible, signIn, test } from "./support";

test("an unauthenticated visitor is sent to sign in, then back to where they were going", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fpricing/);
  await expect(page).toHaveTitle(/^Sign in/);
  await expectAccessible(page);

  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill("x");
  await page.getByRole("button", { name: "Continue" }).click();
  // The second step takes focus; nothing is lost when the form changes.
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await expect(page.getByLabel("6-digit code")).toHaveAttribute("autocomplete", "one-time-code");
  await expectAccessible(page);

  await page.getByLabel("6-digit code").fill(TOTP);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.getByRole("heading", { level: 1, name: "Pricing" })).toBeFocused();
});

test("sign-in errors are announced and say what to do", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("Password")).toHaveAttribute("autocomplete", "current-password");

  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByLabel("Password").fill("x");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "don’t match an account" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeFocused();
  await expectAccessible(page);

  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That code isn’t right" })).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toBeFocused();
});

test("`next` cannot send the owner to another site", async ({ page }) => {
  await signIn(page, "/sign-in?next=//evil.example/x");
  await expect(page).toHaveURL(/\/leads$/);
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goto("/leads");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("the mock API refuses a request without a token", async ({ request }) => {
  const response = await request.get("/mock-api/leads");
  expect(response.status()).toBe(401);
  expect((await response.json()).error.code).toBe("unauthenticated");
});

test("an idle session warns two minutes before it ends, and can be kept", async ({ page }) => {
  await page.clock.install();
  await signIn(page);
  await page.clock.fastForward("27:00");
  await expect(page.getByRole("alertdialog")).toBeHidden();

  await page.clock.fastForward("01:30");
  const warning = page.getByRole("alertdialog", { name: "You’re about to be signed out" });
  await expect(warning).toBeVisible();
  await expectAccessible(page, { reflow: false });

  await warning.getByRole("button", { name: "Stay signed in" }).click();
  await expect(warning).toBeHidden();
  await page.clock.fastForward("20:00");
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("a forced sign-out keeps unsaved pricing changes and returns to them", async ({ page }) => {
  await page.clock.install();
  await signIn(page, `/pricing/${V2}`);
  await page.getByRole("button", { name: "New draft from version 2" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Version 3, draft" })).toBeVisible();
  const draftUrl = page.url();

  await page.getByLabel("Category 1, flat rate in dollars").fill("61.00");
  await expect(page.getByText("You have unsaved changes.")).toBeVisible();

  // No clicks or keys for the whole session: the warning, then the sign-out.
  await page.clock.fastForward("28:30");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.clock.fastForward("02:00");
  await expect(page).toHaveURL(/\/sign-in\?.*reason=expired/);
  await expect(page.getByRole("status").filter({ hasText: "signed out after a period of inactivity" })).toBeVisible();

  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill("x");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("6-digit code").fill(TOTP);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(draftUrl);
  await expect(page.getByText("Unsaved changes from earlier in this browser tab were restored")).toBeVisible();
  await expect(page.getByLabel("Category 1, flat rate in dollars")).toHaveValue("61.00");
  // Discarding goes back to what the server has: the value copied from version 2.
  await page.getByRole("button", { name: "Discard them" }).click();
  await expect(page.getByLabel("Category 1, flat rate in dollars")).toHaveValue("45.00");
});
