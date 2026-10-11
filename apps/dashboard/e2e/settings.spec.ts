import { expect, expectAccessible, signIn, test } from "./support";

test("embed settings: snippet, allowed sites, brand color", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page, "/settings/embed");
  await expect(page).toHaveTitle(/^Embed settings/);
  await expectAccessible(page);

  // The snippet is the design's one script tag, keyed by the company slug.
  const snippet = page.getByRole("group", { name: "Embed snippet" }).or(page.locator('pre[aria-labelledby="snippet-label"]'));
  await expect(snippet).toHaveText('<script src="https://widget.example.test/v1.js" data-company="nittany-lawn" async></script>');
  await expect(page.locator('pre[aria-labelledby="hosted-label"]')).toHaveText("https://w.example.test/w/nittany-lawn");
  await page.getByRole("button", { name: "Copy embed snippet" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Copied." })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('data-company="nittany-lawn"');

  // The hosted page link as a QR code, named for where it leads, and a picture of it to print.
  await expect(page.getByRole("img", { name: "QR code that opens https://w.example.test/w/nittany-lawn" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download QR code" }).click();
  expect((await download).suggestedFilename()).toBe("nittany-lawn-quote-qr.png");
  await expect(page.getByRole("status").filter({ hasText: "Downloaded." })).toBeVisible();

  // Allowed sites: an address is reduced to its origin; nonsense and repeats are explained.
  const address = page.getByLabel("Website address to allow");
  await address.fill("not a site");
  await page.getByRole("button", { name: "Add site" }).click();
  await expect(address).toHaveAccessibleDescription(/Enter a website address, such as https:\/\/www.example.com/);
  await address.fill("https://www.nittanylawn.example/quote");
  await page.keyboard.press("Enter");
  await expect(address).toHaveAccessibleDescription(/already on the list/);
  await address.fill("nittanylawn.example/get-a-quote?from=home");
  await page.keyboard.press("Enter");
  const sites = page.locator(".origin-list li");
  await expect(sites).toHaveText([/^https:\/\/www\.nittanylawn\.example/, /^https:\/\/nittanylawn\.example/]);
  await expect(address).toHaveValue("");

  // Brand color: only a hex code is accepted, and the page says how the widget will use it.
  const color = page.getByLabel(/^Brand color/);
  await color.fill("green");
  await page.getByRole("button", { name: "Save settings" }).click();
  const summary = page.getByRole("alert").filter({ hasText: "There is 1 problem to fix" });
  await expect(summary).toBeFocused();
  await expectAccessible(page);
  await summary.getByRole("link").click();
  await expect(color).toBeFocused();
  await color.fill("#ffd400");
  await expect(page.getByText(/#ffd400 will fill the widget’s buttons with dark text/)).toBeVisible();

  await page.getByLabel(/^HIC registration number/).fill("PA123456");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Settings saved at/ })).toBeVisible();

  await page.reload();
  await expect(sites).toHaveCount(2);
  await expect(color).toHaveValue("#ffd400");
  await expect(page.getByLabel(/^HIC registration number/)).toHaveValue("PA123456");

  // Removing a site keeps focus somewhere useful and is announced.
  await page.getByRole("button", { name: "Remove https://nittanylawn.example" }).click();
  await expect(sites).toHaveCount(1);
  await expect(address).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "removed. Save settings to apply." })).toBeVisible();
  await expectAccessible(page);
});
