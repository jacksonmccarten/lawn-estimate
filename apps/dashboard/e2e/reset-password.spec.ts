// Forgotten password: an emailed code and a new password. Against the mock,
// whose code is fixed; no email is sent.

import { OWNER_EMAIL, expect, expectAccessible, test } from "./support";

test("an owner who forgot their password sets a new one and is sent back to sign in", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByRole("link", { name: "Forgot your password?" }).click();

  // The address typed on the sign-in screen comes along.
  await expect(page).toHaveURL(/\/reset-password\?email=/);
  await expect(page).toHaveTitle(/^Reset your password/);
  await expect(page.getByLabel("Email")).toHaveValue(OWNER_EMAIL);
  await expectAccessible(page);

  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Choose a new password" })).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await expect(page.getByLabel("New password")).toHaveAttribute("autocomplete", "new-password");
  await expectAccessible(page);

  await page.getByLabel("6-digit code").fill("123456");
  await page.getByLabel("New password").fill("short");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
  await expect(page.getByLabel("New password")).toBeFocused();

  await page.getByLabel("6-digit code").fill("000000");
  await page.getByLabel("New password").fill("Correct-Horse-9");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText("That code isn’t right, or it has expired.")).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toBeFocused();
  await expectAccessible(page);

  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByRole("status").filter({ hasText: "we sent a new code" })).toBeVisible();

  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page).toHaveURL(/\/sign-in\?reset=1$/);
  await expect(page.getByRole("status").filter({ hasText: "Your password has been changed." })).toBeVisible();
  await expectAccessible(page);
});

test("asking for a reset says the same thing for an address with no account", async ({ page }) => {
  await page.goto("/reset-password");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByText("Enter an email address like name@example.com.")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeFocused();

  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Choose a new password" })).toBeVisible();
  await expect(page.getByText("If nobody@example.com has an account, we’ve emailed it a 6-digit code.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/sign-in");
});
