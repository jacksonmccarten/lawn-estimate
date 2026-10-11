import { expect, expectAccessible, signIn, test } from "./support";

const ROUTES = [
  { path: "/leads", heading: "Leads" },
  { path: "/pricing", heading: "Pricing" },
  { path: "/settings/embed", heading: "Embed settings" },
  { path: "/help", heading: "Help" },
];

test("skip link, landmarks, and help in the same place on every screen", async ({ page }) => {
  await signIn(page);
  for (const route of ROUTES) {
    await page.goto(route.path);
    await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
    await expect(page.getByRole("banner").getByRole("link", { name: "Help" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  }

  // The skip link is the first stop and lands on the main content.
  await page.goto("/leads");
  await expect(page.getByRole("table")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});

test("navigating sets the title, marks the current page and moves focus to the heading", async ({ page }) => {
  await signIn(page);
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Leads" })).toHaveAttribute("aria-current", "page");

  await nav.getByRole("link", { name: "Pricing" }).click();
  await expect(page).toHaveTitle(/^Pricing/);
  await expect(page.getByRole("heading", { level: 1, name: "Pricing" })).toBeFocused();
  await expect(nav.getByRole("link", { name: "Pricing" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Leads" })).not.toHaveAttribute("aria-current");

  await nav.getByRole("link", { name: "Embed settings" }).click();
  await expect(page).toHaveTitle(/^Embed settings/);
  await expect(page.getByRole("heading", { level: 1, name: "Embed settings" })).toBeFocused();

  await page.getByRole("banner").getByRole("link", { name: "Help" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Help" })).toBeFocused();
  await expectAccessible(page);
});

test("the dashboard cannot be framed", async ({ request }) => {
  const response = await request.get("/sign-in");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
});
