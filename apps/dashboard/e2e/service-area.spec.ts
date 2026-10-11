// The Service area screen: a business address and a radius, saved together.
// Against the mock, which knows the centre points of a handful of zip codes
// around State College.

import { expect, expectAccessible, signIn, test } from "./support";

test("the owner sets a business address and radius, and it is kept", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Service area" }).click();
  await expect(page).toHaveURL(/\/settings\/area$/);
  await expect(page.getByRole("heading", { level: 1, name: "Service area" })).toBeVisible();
  await expect(page.getByText("Now: No service area set yet.")).toBeVisible();

  // Two inputs: the address (four boxes) and the radius. Nothing else to set.
  await expect(page.getByRole("group", { name: "Business address" })).toBeVisible();
  await expect(page.getByLabel("Street address")).toHaveAttribute("autocomplete", "address-line1");
  await expect(page.getByLabel("State")).toHaveValue("PA");
  await expect(page.getByLabel("Service radius, in miles")).toHaveValue("15");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByLabel("Area name")).toHaveCount(0);
  await expectAccessible(page);

  await page.getByLabel("Street address").fill("200 W College Ave");
  await page.getByLabel("City").fill("State College");
  await page.getByRole("textbox", { name: "Zip code" }).fill("16801");
  await page.getByLabel("Service radius, in miles").fill("5");

  const saved = page.waitForRequest((request) => request.method() === "PUT" && request.url().endsWith("/service-area"));
  await page.getByRole("button", { name: "Save service area" }).click();
  expect((await saved).postDataJSON()).toEqual({ street: "200 W College Ave", city: "State College", state: "PA", zip: "16801", miles: 5 });
  const summary = "Within 5 miles of 200 W College Ave, State College, PA 16801: 3 zip codes.";
  await expect(page.getByRole("status").filter({ hasText: `Saved. ${summary}` })).toBeVisible();
  await expect(page.getByText(`Now: ${summary}`)).toBeVisible();
  await expectAccessible(page);

  // Kept after a reload, and a wider radius covers more.
  await page.reload();
  await expect(page.getByLabel("Street address")).toHaveValue("200 W College Ave");
  await expect(page.getByLabel("Service radius, in miles")).toHaveValue("5");
  await page.getByLabel("Service radius, in miles").fill("15");
  await page.getByRole("button", { name: "Save service area" }).click();
  await expect(page.getByText("Now: Within 15 miles of 200 W College Ave, State College, PA 16801: 5 zip codes.")).toBeVisible();
});

test("the form says what is wrong, at the box", async ({ page }) => {
  await signIn(page, "/settings/area");
  await page.getByLabel("Service radius, in miles").fill("0");
  await page.getByRole("button", { name: "Save service area" }).click();
  await expect(page.getByText("Enter your business’s street address.")).toBeVisible();
  await expect(page.getByText("Enter the city or town.")).toBeVisible();
  await expect(page.getByText("Enter the five-digit zip code.")).toBeVisible();
  await expect(page.getByText("Enter a distance from 1 to 100 miles.")).toBeVisible();
  await expect(page.getByLabel("Street address")).toBeFocused();
  await expectAccessible(page);

  // A zip code with no location on file.
  await page.getByLabel("Street address").fill("1 Main St");
  await page.getByLabel("City").fill("Nowhere");
  await page.getByRole("textbox", { name: "Zip code" }).fill("00000");
  await page.getByLabel("Service radius, in miles").fill("10");
  await page.getByRole("button", { name: "Save service area" }).click();
  await expect(page.getByText("We don’t have a location for that zip code.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Zip code" })).toBeFocused();
  await expect(page.getByText("Now: No service area set yet.")).toBeVisible();
});
