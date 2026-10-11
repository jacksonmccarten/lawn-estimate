import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Frame, type Locator, type Page } from "@playwright/test";

type Fixtures = {
  /**
   * Console errors and uncaught exceptions, which is where a
   * Content-Security-Policy violation shows up. Every test must end with
   * none; a test that provokes one on purpose empties the list itself.
   */
  problems: string[];
};

export const test = base.extend<Fixtures>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      page.on("pageerror", (error) => problems.push(String(error)));
      await use(problems);
      expect(problems, "console errors, including CSP violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** WCAG 2.2 A and AA, on the page and inside any iframe on it. */
export async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** The widget's own alerts. (Next's route announcer is a second, always empty, role=alert.) */
export function alertIn(scope: Page | Frame): Locator {
  return scope.locator(".lq-alert[role=alert]");
}

export const ADDRESS = {
  lancaster: "412 Maple Ave, Lancaster, PA 17601",
  pittsburgh: "88 Ridge Rd, Pittsburgh, PA 15237",
  philadelphia: "7 Ridge Ave, Philadelphia, PA 19128",
  nowhere: "23 Nowhere St, Lancaster, PA 17601",
  delaware: "500 Market St, Wilmington, DE 19801",
};

export const MOWING = "Mowing, trimming and edging";

/** Types an address written on one line ("412 Maple Ave, Lancaster, PA 17601") into the form's four boxes. */
export async function fillAddress(scope: Page | Frame, address: string) {
  const match = /^(.+), (.+), ([A-Za-z]{2}) (\d{5})$/.exec(address);
  if (!match) throw new Error(`not "street, city, ST zip": ${address}`);
  const [, street, city, state, zip] = match;
  await scope.getByLabel("Street address").fill(street!);
  await scope.getByLabel("City").fill(city!);
  await scope.getByLabel("State").fill(state!);
  await scope.getByLabel("Zip code").fill(zip!);
}

/** Picks a service, types an address and submits. */
export async function estimateFor(scope: Page | Frame, address: string, service = MOWING) {
  await fillAddress(scope, address);
  await scope.getByRole("radio", { name: service }).check();
  await scope.getByRole("button", { name: "Get my estimate" }).click();
}

/** The same widget build served with a Mapbox token (playwright.config.ts): the address leads to the aerial photo. */
export const MAP_ORIGIN = "http://localhost:3103";

/** As estimateFor, on the build with a Mapbox token: the address form's button finds the property first. */
export async function estimateFromPhoto(scope: Page | Frame, address: string, service = MOWING) {
  await fillAddress(scope, address);
  await scope.getByRole("radio", { name: service }).check();
  await scope.getByRole("button", { name: "Find my property" }).click();
}

// The stand-in company website of e2e/host-server.mjs, under two names: one
// joes-lawn allows to embed it and one it does not.
const HOST_PORT = 3102;
export const HOST = `http://host.localhost:${HOST_PORT}`;
export const OTHER_HOST = `http://other.localhost:${HOST_PORT}`;
export const MALLORY = `http://mallory.localhost:${HOST_PORT}/mallory`;

type HostOptions = { origin?: string; company?: string; spacer?: number; expectBlocked?: boolean };

/**
 * Opens a host page that embeds the widget and returns the widget's frame.
 * Unless the embed is expected to be refused, it waits for the handshake
 * (the iframe's title gains the company name), which also means the widget
 * has hydrated and will not lose what a test types into it.
 */
export async function openHost(page: Page, options: HostOptions = {}): Promise<Frame> {
  const query = new URLSearchParams({ company: options.company ?? "joes-lawn", spacer: String(options.spacer ?? 0) });
  await page.goto(`${options.origin ?? HOST}/?${query}`);
  const iframe = page.locator("iframe");
  await iframe.scrollIntoViewIfNeeded(); // it loads lazily
  if (!options.expectBlocked) await expect(iframe).toHaveAttribute("title", /^Instant lawn quote from ./);
  return (await (await iframe.elementHandle())!.contentFrame())!;
}
