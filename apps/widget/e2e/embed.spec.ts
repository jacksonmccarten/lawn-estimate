// v1.js on a page at another origin: the iframe it injects, the resize
// handshake, and who is allowed to frame the widget at all.

import type { Frame, Page } from "@playwright/test";
import { ADDRESS, estimateFor, expect, expectAxeClean, HOST, MALLORY, openHost, OTHER_HOST, test } from "./support";

const frameHeight = (page: Page) => page.locator("iframe").first().evaluate((frame) => frame.getBoundingClientRect().height);
const contentHeight = (widget: Frame) => widget.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));

/** The iframe is exactly as tall as the document inside it. */
async function expectFitted(page: Page, widget: Frame) {
  await expect.poll(async () => (await frameHeight(page)) - (await contentHeight(widget))).toBe(0);
}

test.describe("embedded on an allowed origin", () => {
  test("injects one titled iframe and sizes it to its content", async ({ page, baseURL }) => {
    const widget = await openHost(page);
    const iframe = page.locator("iframe");
    await expect(iframe).toHaveCount(1);
    await expect(iframe).toHaveAttribute("src", `${baseURL}/w/joes-lawn`);
    await expect(iframe).toHaveAttribute("loading", "lazy");
    // H64: the title gains the company's name once the widget reports it.
    await expect(iframe).toHaveAttribute("title", "Instant lawn quote from Joe's Lawn Care");

    await expect(widget.getByRole("heading", { level: 1 })).toHaveText("Get an instant lawn estimate");
    await expectFitted(page, widget);
    const before = await frameHeight(page);
    expect(before).not.toBe(520); // no longer the placeholder height

    // What appears in the widget grows the iframe instead of being clipped by it.
    await widget.getByRole("button", { name: "Get my estimate" }).click();
    await expect(widget.getByText("There are 3 problems")).toBeVisible();
    await expect.poll(() => frameHeight(page)).toBeGreaterThan(before);
    await expectFitted(page, widget);
    // The summary took focus, and the host page shows it.
    await expect(page.frameLocator("iframe").getByText("There are 3 problems")).toBeInViewport();
  });

  test("reports the embedding origin to the API and the lead to the host's dataLayer", async ({ page }) => {
    await page.addInitScript(() => {
      if (window.top === window) (window as unknown as { dataLayer: unknown[] }).dataLayer = [];
    });
    const widget = await openHost(page);

    const estimate = page.waitForRequest("**/estimate");
    await estimateFor(widget, ADDRESS.lancaster);
    expect((await estimate).postDataJSON().embedOrigin).toBe(HOST);
    await expect(widget.locator(".lq-price-amount")).toHaveText("$50.88");
    await expectFitted(page, widget);
    expect(await frameHeight(page)).toBeGreaterThan(700);
    await expectAxeClean(page);

    await widget.getByLabel("Name").fill("Pat Example");
    await widget.getByLabel("Email").fill("pat@example.com");
    const submit = page.waitForRequest("**/submit");
    await widget.getByRole("button", { name: "Request service" }).click();
    expect((await submit).postDataJSON().embedOrigin).toBe(HOST);
    await expect(widget.getByRole("heading", { level: 1, name: "Request sent" })).toBeVisible();

    // The event and the public slug; nothing about the homeowner.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { dataLayer: unknown[] }).dataLayer))
      .toEqual([{ event: "lq:submitted", company: "joes-lawn" }]);
    // The confirmation is short; the iframe shrinks back to fit it.
    await expectFitted(page, widget);
    expect(await frameHeight(page)).toBeLessThan(400);
  });

  test("follows the content when the host page narrows, as it does under zoom", async ({ page }) => {
    const widget = await openHost(page);
    await estimateFor(widget, ADDRESS.pittsburgh);
    await expect(widget.locator(".lq-price-amount")).toBeVisible();
    await expectFitted(page, widget);
    const wide = await frameHeight(page);

    // Zooming a page narrows its layout; 320 px is the WCAG reflow floor.
    await page.setViewportSize({ width: 320, height: 844 });
    await expect.poll(() => frameHeight(page)).toBeGreaterThan(wide);
    await expectFitted(page, widget);
    expect(await widget.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("brings a focused control into view on the host page", async ({ page }) => {
    // The widget sits a long way down the host page.
    const widget = await openHost(page, { spacer: 3000 });
    await expect(widget.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await widget.getByLabel("Street address").evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
    await expect(page.frameLocator("iframe").getByLabel("Street address")).toBeInViewport();
  });

  test("ignores messages that do not come from its own iframe", async ({ page }) => {
    const widget = await openHost(page);
    const iframe = page.locator("iframe").first();
    await expect(iframe).toHaveAttribute("title", /Joe's Lawn Care/);
    await expectFitted(page, widget);
    const height = await frameHeight(page);

    // From the host page itself, and from a second frame at another origin.
    await page.evaluate(async (mallory) => {
      window.postMessage({ type: "lq:resize", height: 5000 }, "*");
      window.postMessage({ type: "lq:meta", name: "Mallory" }, "*");
      const other = document.createElement("iframe");
      other.title = "Another frame";
      document.body.appendChild(other);
      await new Promise((resolve) => {
        other.onload = resolve;
        other.src = mallory;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }, MALLORY);
    expect(await frameHeight(page)).toBe(height);
    await expect(iframe).toHaveAttribute("title", "Instant lawn quote from Joe's Lawn Care");
  });

  test("does nothing for a data-company that is not a slug", async ({ page }) => {
    await page.goto(`${HOST}/?company=${encodeURIComponent("Not A Slug/../x")}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("iframe")).toHaveCount(0);
  });
});

test.describe("frame-ancestors", () => {
  test("blocks a site that is not on the company's list", async ({ page, problems }) => {
    await openHost(page, { origin: OTHER_HOST, expectBlocked: true });
    await expect.poll(() => problems.join("\n")).toContain("frame-ancestors");
    // The browser refused to render the widget inside the frame.
    await expect(page.frameLocator("iframe").getByRole("heading", { level: 1, name: "Get an instant lawn estimate" })).toHaveCount(0);
    problems.length = 0;
  });

  test("allows any site when the company's list is empty, and its hosted page works", async ({ page }) => {
    await openHost(page, { company: "sunny-yards", origin: OTHER_HOST });
    await expect(page.frameLocator("iframe").getByRole("heading", { level: 1, name: "Get an instant lawn estimate" })).toBeVisible();

    await page.goto("/w/sunny-yards");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Get an instant lawn estimate");
  });
});

test.describe("v1.js itself", () => {
  test("is small, cacheable for an hour, and has a pinned copy that never changes", async ({ request }) => {
    const script = await request.get("/v1.js");
    expect(script.headers()["cache-control"]).toBe("public, max-age=3600, stale-while-revalidate=86400");
    expect(script.headers()["content-type"]).toContain("javascript");
    const body = await script.text();
    expect(body.length).toBeLessThan(3072);
    expect(body).not.toMatch(/\beval\b|new Function|document\.cookie|localStorage|innerHTML/);

    const manifest = await (await request.get("/embed/v1.json")).json();
    const pinned = await request.get(manifest.file);
    expect(pinned.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(await pinned.text()).toBe(body);
    expect(manifest.integrity).toMatch(/^sha384-/);
  });
});
