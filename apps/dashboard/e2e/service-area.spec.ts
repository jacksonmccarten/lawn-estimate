// The Service area screen: one section to create an area from a name and a
// centre address, and a list to remove one. Each change saves at once.
// Against the mock, which knows the centre points of a handful of zip codes
// around State College.

import { expect, expectAccessible, signIn, test } from "./support";

test("the owner creates a service area from a name and a centre address, and it is in Pricing at once", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Service area" }).click();
  await expect(page).toHaveURL(/\/settings\/area$/);
  await expect(page.getByRole("heading", { level: 1, name: "Service area" })).toBeVisible();

  // The seeded company's two areas are listed; there is no county list to tick.
  const list = page.locator(".area-list li");
  await expect(list).toHaveText([/^core · 3 zip codes$/, /^outer · 1 zip code$/]);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expectAccessible(page);

  // The centre address is four boxes, and the button names the area being added.
  const add = page.getByRole("button", { name: "Add service area" });
  await expect(add).toBeVisible();
  await page.getByLabel("Area name").fill("East Side");
  await expect(page.getByRole("button", { name: "Add East Side" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Centre address" })).toBeVisible();
  await expect(page.getByLabel("Street address")).toHaveAttribute("autocomplete", "address-line1");
  await expect(page.getByLabel("State")).toHaveValue("PA");
  await page.getByLabel("Street address").fill("200 W College Ave");
  await page.getByLabel("City").fill("State College");
  await page.getByRole("textbox", { name: "Zip code" }).fill("16801");
  await page.getByLabel("Distance from the centre, in miles").fill("5");

  // One press finds the zip codes and saves. 16801 and 16803 are already in "core", so only the third is new.
  const saved = page.waitForRequest((request) => request.method() === "PUT" && request.url().endsWith("/regions"));
  await page.getByRole("button", { name: "Add East Side" }).click();
  const body = (await saved).postDataJSON() as { regions: { kind: string; value: string; tierGroup: string }[] };
  expect(body.regions).toContainEqual({ kind: "zip", value: "16827", tierGroup: "east-side" });
  expect(body.regions.filter((r) => r.tierGroup === "east-side")).toHaveLength(1);
  await expect(
    page.getByRole("status").filter({ hasText: "Added east-side: 1 zip code within 5 miles of 16801. 2 more were already in another service area and stay there. It is now a region group in Pricing." }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Your service areas" })).toBeFocused();
  await expect(list).toHaveText([/^core/, /^outer/, /^east-side · 1 zip code$/]);
  // The form is ready for another.
  await expect(page.getByLabel("Area name")).toHaveValue("");
  await expectAccessible(page);

  // In Pricing, a new draft's tier can be given the new region group.
  await page.getByRole("link", { name: "Pricing" }).first().click();
  await page.getByRole("button", { name: /^New draft from version/ }).click();
  await expect(page).toHaveURL(/\/pricing\/[0-9a-f-]+$/);
  await page.getByRole("button", { name: "Add tier" }).click();
  await page.getByRole("button", { name: /Tier \d+, region group/ }).last().click();
  await expect(page.getByRole("option", { name: "east-side", exact: true })).toBeVisible();
});

test("a service area is removed from a list, and the change is saved", async ({ page }) => {
  await signIn(page, "/settings/area");
  const remove = page.getByRole("button", { name: "Remove", exact: true });
  await expect(remove).toBeDisabled();

  await page.getByRole("button", { name: /Service area to remove/ }).click();
  await expect(page.getByRole("option")).toHaveText(["core (3 zip codes)", "outer (1 zip code)"]);
  await page.getByRole("option", { name: "outer (1 zip code)" }).click();

  const saved = page.waitForRequest((request) => request.method() === "PUT" && request.url().endsWith("/regions"));
  await page.getByRole("button", { name: "Remove outer" }).click();
  const body = (await saved).postDataJSON() as { regions: { tierGroup: string }[] };
  expect(body.regions.some((r) => r.tierGroup === "outer")).toBe(false);
  expect(body.regions).toHaveLength(3);
  await expect(page.getByRole("status").filter({ hasText: "Removed outer." })).toBeVisible();
  await expect(page.locator(".area-list li")).toHaveText([/^core/]);
  await expectAccessible(page);

  // It is gone after a reload too.
  await page.reload();
  await expect(page.locator(".area-list li")).toHaveText([/^core/]);
});

test("the new-area form says what is wrong, at the box", async ({ page }) => {
  await signIn(page, "/settings/area");
  await page.getByRole("button", { name: "Add service area" }).click();
  await expect(page.getByText("Give the area a name, like Near the shop.")).toBeVisible();
  await expect(page.getByText("Enter the street address at the centre of the area.")).toBeVisible();
  await expect(page.getByText("Enter the city or town.")).toBeVisible();
  await expect(page.getByText("Enter the five-digit zip code.")).toBeVisible();
  await expect(page.getByLabel("Area name")).toBeFocused();
  await expectAccessible(page);

  // A name another area already has.
  await page.getByLabel("Area name").fill("Core");
  await page.getByLabel("Street address").fill("1 Main St");
  await page.getByLabel("City").fill("Nowhere");
  await page.getByRole("textbox", { name: "Zip code" }).fill("00000");
  await page.getByRole("button", { name: "Add Core" }).click();
  await expect(page.getByText("You already have a service area with this name.")).toBeVisible();

  // A zip code with no location on file.
  await page.getByLabel("Area name").fill("Nowhere");
  await page.getByRole("button", { name: "Add Nowhere" }).click();
  await expect(page.getByText("We don’t have a location for that zip code.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Zip code" })).toBeFocused();

  // Every zip code in range already belongs to another area.
  await page.getByRole("textbox", { name: "Zip code" }).fill("16801");
  await page.getByLabel("Distance from the centre, in miles").fill("1");
  await page.getByRole("button", { name: "Add Nowhere" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already in another of your service areas" })).toBeVisible();
  await expect(page.locator(".area-list li")).toHaveCount(2);
});
