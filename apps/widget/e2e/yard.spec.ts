// The aerial photo screen at 390 px: the address is found, the lawn is
// outlined by pointer or by keyboard alone, and the estimate is priced from
// the outline. Runs against the build that has a Mapbox token (playwright
// config, MAP_PORT); Mapbox itself is stubbed, so no test calls it.

import type { Page, Route } from "@playwright/test";
import { ADDRESS, estimateFromPhoto, expect, expectAxeClean, MAP_ORIGIN, test } from "./support";

// A 1x1 PNG, standing in for the satellite photo.
const PHOTO = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgaGD4DwAChAGAZ8rKRwAAAABJRU5ErkJggg==", "base64");

const LANCASTER = { lng: -76.3055, lat: 40.0379 };

/** Stubs Mapbox: one address match (or none), and the photo. Returns the URLs asked for. */
async function stubMapbox(page: Page, match = true) {
  const asked: URL[] = [];
  await page.route("https://api.mapbox.com/**", async (route: Route) => {
    const url = new URL(route.request().url());
    asked.push(url);
    if (url.pathname.startsWith("/search/geocode/")) {
      const features = match
        ? [
            {
              geometry: { coordinates: [LANCASTER.lng, LANCASTER.lat] },
              // A zip that is not the one typed: the widget must not use it.
              properties: { feature_type: "address", context: { postcode: { name: "99999" } } },
            },
          ]
        : [];
      // Geocoding is a cross-origin fetch, so the stub answers its CORS check too.
      await route.fulfill({ json: { features }, headers: { "access-control-allow-origin": "*" } });
    } else {
      await route.fulfill({ contentType: "image/png", body: PHOTO });
    }
  });
  return asked;
}

const outline = (page: Page) => page.getByRole("application", { name: "Lawn outline" });
const status = (page: Page) => page.locator("#lq-yard-status");

async function openPhoto(page: Page) {
  await page.goto(`${MAP_ORIGIN}/w/joes-lawn`);
  await estimateFromPhoto(page, ADDRESS.lancaster);
  await expect(page.getByRole("heading", { level: 1, name: "Outline your lawn" })).toBeFocused();
}

test("finds the address, takes an outline by pointer and prices it", async ({ page }) => {
  const asked = await stubMapbox(page);
  await openPhoto(page);
  await expectAxeClean(page);

  // One geocoding call for the typed address, then the photo around its position.
  const [lookup, photo] = asked;
  expect(lookup!.searchParams.get("q")).toBe(ADDRESS.lancaster);
  expect(lookup!.searchParams.get("types")).toBe("address");
  expect(photo!.pathname).toContain("/styles/v1/mapbox/satellite-v9/static/-76.305500,40.037900,18,0/");

  // Two pictures of the same place: the one shown, with Mapbox's logo and credit drawn on it, and a
  // wider one behind it without them, which is what a drag brings into view.
  const pictures = asked.filter((url) => url.pathname.includes("/static/"));
  const front = pictures.find((url) => url.pathname.endsWith("/400x400@2x"))!;
  const wide = pictures.find((url) => url.pathname.endsWith("/800x800@2x"))!;
  expect(front.searchParams.has("attribution")).toBe(false);
  expect(front.searchParams.has("logo")).toBe(false);
  expect([wide.searchParams.get("attribution"), wide.searchParams.get("logo")]).toEqual(["false", "false"]);
  expect(wide.pathname.replace("800x800", "400x400")).toBe(front.pathname);
  // At rest the front picture covers the frame exactly, so its credit is never cropped.
  const frame = (await page.locator(".lq-map").boundingBox())!;
  const shown = (await page.locator(".lq-map-photo").boundingBox())!;
  expect(Math.abs(shown.width - frame.width)).toBeLessThan(3);
  expect(Math.abs(shown.x - frame.x)).toBeLessThan(2);

  await expect(status(page)).toHaveText("No corners placed yet.");
  const map = outline(page);
  await map.click({ position: { x: 100, y: 100 } });
  await map.click({ position: { x: 250, y: 100 } });
  await expect(status(page)).toHaveText("2 of at least 3 corners placed.");
  await map.click({ position: { x: 250, y: 250 } });
  await map.click({ position: { x: 100, y: 250 } });
  // 150 CSS px a side at zoom 18 is about 38.5 m: some 16,000 sq ft.
  await expect(status(page)).toHaveText("Lawn outlined: about 16,000 sq ft.");
  await expect(map.locator("polygon.lq-map-area")).toHaveCount(1);
  await expectAxeClean(page);

  const sent = page.waitForRequest((request) => request.url().endsWith("/estimate"));
  await page.getByRole("button", { name: "Get my estimate" }).click();
  const body = (await sent).postDataJSON() as { address: string; manual: { zip: string; size: { kind: string; sqft: number } } };
  expect(body.address).toBe(ADDRESS.lancaster);
  expect(body.manual.zip).toBe("17601");
  expect(body.manual.size.kind).toBe("drawn");
  expect(body.manual.size.sqft).toBeGreaterThan(15_500);
  expect(body.manual.size.sqft).toBeLessThan(16_500);

  await expect(page.getByRole("heading", { level: 1, name: "Your estimate" })).toBeFocused();
  await expect(page.getByText("From the lawn you outlined. Measured on an aerial photo, not a survey.")).toBeVisible();
  await expect(page.getByText(/estimate from the lawn you outlined on an aerial photo/)).toBeVisible();
  // An outlined lawn is not offered the parcel adjustment.
  await expect(page.getByText("Does that lawn size look right?")).toHaveCount(0);
  await expectAxeClean(page);
});

test("is operable from the keyboard alone", async ({ page }) => {
  const asked = await stubMapbox(page);
  await openPhoto(page);

  const map = outline(page);
  await map.focus();
  await expect(map.locator(".lq-map-cursor")).toBeVisible();
  // A corner at the middle, then two more reached with the arrow keys.
  await page.keyboard.press("Enter");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  // A right triangle with 100-pixel legs: about 22.9 m each, some 2,800 sq ft.
  await expect(status(page)).toHaveText("Lawn outlined: about 2,800 sq ft.");

  await page.keyboard.press("Backspace");
  await expect(status(page)).toHaveText("2 of at least 3 corners placed.");
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Lawn outlined: about 2,800 sq ft.");

  // The tools follow the photo in the tab order and work with Enter.
  // After the outline come the controls on the photo: zoom, then the move button, which the arrow keys drive.
  const photos = () => asked.filter((url) => url.pathname.endsWith("/400x400@2x")).length;
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeFocused();
  await page.keyboard.press("Tab");
  const move = page.getByRole("button", { name: "Move the photo" });
  await expect(move).toBeFocused();
  const before = photos();
  await page.keyboard.press("ArrowRight");
  await expect.poll(photos).toBe(before + 1);
  // A quarter of the photo to the east: the same lawn, so the same area.
  expect(asked.at(-1)!.pathname).not.toContain("/static/-76.305500,");
  await expect(status(page)).toHaveText("Lawn outlined: about 2,800 sq ft.");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Undo corner" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Start another area" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("Lawn outlined: about 2,800 sq ft.");
  await expect(page.getByRole("button", { name: "Start another area" })).toHaveAttribute("aria-disabled", "true");
});

test("adds a second area, and keeps the outline when the photo moves", async ({ page }) => {
  const asked = await stubMapbox(page);
  await openPhoto(page);
  const map = outline(page);
  for (const [x, y] of [[40, 40], [140, 40], [140, 140], [40, 140]] as const) await map.click({ position: { x, y } });
  await page.getByRole("button", { name: "Start another area" }).click();
  for (const [x, y] of [[200, 200], [300, 200], [300, 300]] as const) await map.click({ position: { x, y } });
  await expect(status(page)).toHaveText(/^Lawn outlined: about [\d,]+ sq ft in 2 areas\.$/);
  const before = await status(page).textContent();

  const photos = () => asked.filter((url) => url.pathname.endsWith("/400x400@2x")).length;
  const loaded = photos();
  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("button", { name: "Move the photo" }).press("ArrowUp");
  await expect.poll(photos).toBe(loaded + 2);
  // Same ground, so the same area, drawn smaller.
  await expect(status(page)).toHaveText(before!);
  await expect(map.locator("polygon.lq-map-area")).toHaveCount(2);

  await page.getByRole("button", { name: "Clear" }).click();
  await expect(status(page)).toHaveText("No corners placed yet.");
});

test("moves the photo by dragging its one move button, or by tapping it and then the photo", async ({ page }) => {
  const asked = await stubMapbox(page);
  await openPhoto(page);
  const map = outline(page);
  for (const [x, y] of [[100, 100], [250, 100], [250, 250]] as const) await map.click({ position: { x, y } });
  const area = await status(page).textContent();
  const photos = () => asked.filter((url) => url.pathname.endsWith("/400x400@2x"));
  const centre = () => /static\/(-?[\d.]+),(-?[\d.]+),/.exec(photos().at(-1)!.pathname)!.slice(1).map(Number) as [number, number];
  const [lng0, lat0] = centre();

  // The controls sit on the photo: zoom at the top right, move at the bottom right, clear of the credit in the corner.
  const frame = (await page.locator(".lq-map").boundingBox())!;
  const move = page.getByRole("button", { name: "Move the photo" });
  const handle = (await move.boundingBox())!;
  const zoomIn = (await page.getByRole("button", { name: "Zoom in" }).boundingBox())!;
  expect(handle.x + handle.width).toBeGreaterThan(frame.x + frame.width - 60);
  expect(handle.y + handle.height).toBeLessThan(frame.y + frame.height - 16);
  expect(handle.y).toBeGreaterThan(frame.y + frame.height / 2);
  expect(zoomIn.x + zoomIn.width).toBeGreaterThan(frame.x + frame.width - 60);
  expect(zoomIn.y).toBeLessThan(frame.y + 40);
  expect(zoomIn.width).toBeLessThan(handle.width);

  // Drag: pull the photo left and up, so the view moves east and south.
  const loaded = photos().length;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 60, handle.y + handle.height / 2 - 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => photos().length).toBe(loaded + 1);
  const [lng1, lat1] = centre();
  expect(lng1).toBeGreaterThan(lng0);
  expect(lat1).toBeLessThan(lat0);
  // The outline stayed on the same ground, a drag is not a tap, and no corner was added.
  await expect(status(page)).toHaveText(area!);
  await expect(move).toHaveAttribute("aria-pressed", "false");
  await expect(map.locator("circle")).toHaveCount(3);

  // Tap, then tap the photo: the place tapped becomes the centre, and it is not taken as a corner.
  await move.click();
  await expect(move).toHaveAttribute("aria-pressed", "true");
  await expect(status(page)).toHaveText("Tap the photo where its centre should be.");
  await expectAxeClean(page);
  await map.click({ position: { x: 40, y: 40 } });
  await expect.poll(() => photos().length).toBe(loaded + 2);
  const [lng2, lat2] = centre();
  expect(lng2).toBeLessThan(lng1);
  expect(lat2).toBeGreaterThan(lat1);
  await expect(move).toHaveAttribute("aria-pressed", "false");
  await expect(status(page)).toHaveText(area!);
  await expect(map.locator("circle")).toHaveCount(3);

  // A second tap on the button calls it off.
  await move.click();
  await move.click();
  await expect(move).toHaveAttribute("aria-pressed", "false");
});

test("asks for an outline before pricing, and names the problem", async ({ page }) => {
  await stubMapbox(page);
  await openPhoto(page);
  await page.getByRole("button", { name: "Get my estimate" }).click();

  const summary = page.locator(".lq-alert[role=alert]", { hasText: "There is a problem" });
  await expect(summary).toBeFocused();
  await summary.getByRole("link", { name: "Outline the lawn by placing at least 3 corners on the photo." }).click();
  await expect(outline(page)).toBeFocused();
  await expect(outline(page)).toHaveAttribute("aria-invalid", "true");
  await expectAxeClean(page);
});

test("falls back to the lot size when the address is not on the map, or by choice", async ({ page }) => {
  await stubMapbox(page, false);
  await page.goto(`${MAP_ORIGIN}/w/joes-lawn`);
  await estimateFromPhoto(page, ADDRESS.nowhere);
  await expect(page.getByRole("heading", { level: 1, name: "Tell us about the lawn" })).toBeFocused();
  await expect(page.getByText("We couldn't find that address on the map.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Zip code" })).toHaveValue("17601");
  await expectAxeClean(page);

  await page.unroute("https://api.mapbox.com/**");
  await stubMapbox(page);
  await page.getByRole("button", { name: "Change address" }).click();
  await estimateFromPhoto(page, ADDRESS.lancaster);
  await page.getByRole("button", { name: "Enter the lot size instead" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Tell us about the lawn" })).toBeFocused();
  await expect(page.getByText("Give us the zip code and the lot size and we'll estimate from those.")).toBeVisible();
});

test("tells the homeowner when the photo does not load", async ({ page, problems }) => {
  await page.route("https://api.mapbox.com/styles/**", (route) => route.abort());
  await page.route("https://api.mapbox.com/search/**", (route) =>
    route.fulfill({
      json: { features: [{ geometry: { coordinates: [LANCASTER.lng, LANCASTER.lat] }, properties: { feature_type: "address", context: { postcode: { name: "17601" } } } }] },
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await openPhoto(page);
  await expect(page.locator(".lq-alert[role=alert]", { hasText: "The aerial photo didn't load." })).toBeVisible();
  // The failed image request is the one console error this test provokes.
  problems.length = 0;
});
