// The hosted page at 390 px: every screen of the flow, against the recorded
// fixtures, with axe on each screen and the keyboard doing the work wherever
// the design names a keyboard rule.

import errors from "../fixtures/errors.json" with { type: "json" };
import { ADDRESS, alertIn, estimateFor, expect, expectAxeClean, MOWING, test } from "./support";


function recordedError(code: string) {
  const found = errors.find((e) => e.body.error.code === code);
  if (!found) throw new Error(`no recorded error ${code}`);
  return { status: found.httpStatus, contentType: "application/json", body: JSON.stringify(found.body) };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/w/joes-lawn");
});

test.describe("address form", () => {
  test("is operable from the keyboard alone, through to an estimate", async ({ page }) => {
    // One box for each part, each named for the browser so it can fill in a saved address.
    await expect(page.getByRole("group", { name: "Property address" })).toBeVisible();
    const street = page.getByLabel("Street address");
    await expect(street).toHaveAttribute("autocomplete", "address-line1");
    await expect(page.getByLabel("City")).toHaveAttribute("autocomplete", "address-level2");
    await expect(page.getByLabel("State")).toHaveAttribute("autocomplete", "address-level1");
    await expect(page.getByLabel("Zip code")).toHaveAttribute("autocomplete", "postal-code");
    await expect(page.getByLabel("Zip code")).toHaveAttribute("inputmode", "numeric");
    // The launch market is filled in.
    await expect(page.getByLabel("State")).toHaveValue("PA");

    // The service radios come first in the tab order; arrow keys choose within them.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("radio", { name: "Leaf raking" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("radio", { name: MOWING })).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(street).toBeFocused();
    await page.keyboard.type("88 Ridge Rd");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("City")).toBeFocused();
    await page.keyboard.type("Pittsburgh");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("State")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Zip code")).toBeFocused();
    await page.keyboard.type("15237");
    await expectAxeClean(page);

    // Enter in a box sends the form.
    await page.keyboard.press("Enter");
    const heading = page.getByRole("heading", { level: 1, name: "Your estimate" });
    await expect(heading).toBeFocused();
    await expect(page.locator(".lq-price-amount")).toHaveText("$55.64");
    // The four boxes reach the API, and the screen, as one line.
    await expect(page.getByText(ADDRESS.pittsburgh)).toBeVisible();
  });

  test("an incomplete address is refused with a focused summary that links to each box", async ({ page }) => {
    await page.getByRole("button", { name: "Get my estimate" }).click();
    const summary = alertIn(page);
    await expect(summary).toBeFocused();
    await expect(summary).toContainText("There are 3 problems");
    await expect(summary.getByRole("link")).toHaveText([
      "Enter the street address of the property.",
      "Enter the city or town.",
      "Enter the five-digit zip code.",
    ]);
    const street = page.getByLabel("Street address");
    await expect(street).toHaveAttribute("aria-invalid", "true");
    await expect(street).toHaveAccessibleDescription(/Error: Enter the street address of the property\./);
    await expectAxeClean(page);

    await summary.getByRole("link", { name: "Enter the five-digit zip code." }).click();
    await expect(page.getByLabel("Zip code")).toBeFocused();

    // A state must be two letters, and a zip code five digits.
    await street.fill("412 Maple Ave");
    await page.getByLabel("City").fill("Lancaster");
    await page.getByLabel("State").fill("P1");
    await page.getByLabel("Zip code").fill("1760");
    await page.getByRole("button", { name: "Get my estimate" }).click();
    await expect(summary.getByRole("link")).toHaveText(["Enter the state as two letters, like PA.", "Enter the five-digit zip code."]);

    await page.getByLabel("State").fill("pa");
    await page.getByLabel("Zip code").fill("17601");
    await page.getByRole("button", { name: "Get my estimate" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Your estimate" })).toBeFocused();
    await expect(page.getByText(ADDRESS.lancaster)).toBeVisible();
  });
});

test.describe("estimate screen", () => {
  test("shows the price, the assumptions line and the estimate wording", async ({ page }) => {
    await expectAxeClean(page);
    await estimateFor(page, ADDRESS.lancaster);

    await expect(page.locator(".lq-price")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator(".lq-price")).toHaveText(/Estimated total\s*\$50\.88\s*For about 8,400 sq ft of lawn\./);
    // R21
    await expect(page.locator(".lq-assumptions")).toHaveText("Lot size 14,200 sq ft, from county tax records, not a survey.");
    // R3, R4: each line says whether it is taxed; the county and rate are shown.
    const rows = page.getByRole("table", { name: "Estimate breakdown" }).getByRole("row");
    await expect(rows).toHaveText([
      /Item\s*Amount/,
      /Mowing, trimming and edging\s*Taxable\s*\$48\.00/,
      /Subtotal\s*\$48\.00/,
      /Sales tax \(Lancaster County, 6%\)\s*\$2\.88/,
      /Estimated total\s*\$50\.88/,
    ]);
    // R6
    await expect(page.locator(".lq-disclaimer")).toHaveText(
      "This is an estimate from a parcel-based measurement of your yard, using Joe's Lawn Care's published rates. Joe's Lawn Care confirms the final price before work begins.",
    );
    await expect(page.getByRole("button", { name: "Request service" })).toBeVisible();
    await expect(page.getByText(/accept|agree|sign|contract/i)).toHaveCount(0);
    // R17
    await expect(page.getByText("Parcel data © Regrid")).toBeVisible();
    // The address is shown, not asked for again.
    await expect(page.getByText(ADDRESS.lancaster)).toBeVisible();
    await expect(page.getByLabel("Street address")).toHaveCount(0);
    await expectAxeClean(page);
  });

  test("adjusts once, announces the new price, and locks the chips", async ({ page }) => {
    await estimateFor(page, ADDRESS.lancaster);
    const group = page.getByRole("group", { name: "Does that lawn size look right?" });
    const chip = (name: string) => group.getByRole("button", { name });
    await expect(chip("About right")).toHaveAttribute("aria-pressed", "true");
    await expect(group).toHaveAccessibleDescription("You can adjust the size once.");

    const adjustment = page.waitForRequest("**/estimate");
    await chip("Smaller").focus();
    await page.keyboard.press("Enter");
    expect((await adjustment).postDataJSON()).toEqual({
      token: "fx.lancaster-mow",
      adjust: "smaller",
      turnstile: "fixture-turnstile-token",
      embedOrigin: null,
    });

    await expect(page.locator(".lq-price")).toHaveText(/\$42\.40\s*For about 6,300 sq ft of lawn\./);
    await expect(chip("Smaller")).toHaveAttribute("aria-pressed", "true");
    await expect(chip("About right")).toHaveAttribute("aria-pressed", "false");
    await expect(chip("Smaller")).toBeFocused(); // focus stays where the homeowner was
    for (const name of ["Smaller", "About right", "Larger"]) await expect(chip(name)).toHaveAttribute("aria-disabled", "true");
    await expect(group).toHaveAccessibleDescription("The size has been adjusted once. Joe's Lawn Care will confirm it.");
    await expectAxeClean(page);

    // A second adjustment sends nothing.
    let extra = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/estimate")) extra += 1;
    });
    await chip("Larger").click({ force: true }); // Playwright will not click an aria-disabled control unasked
    await expect(page.locator(".lq-price-amount")).toHaveText("$42.40");
    expect(extra).toBe(0);
  });

  test("keeps a non-taxable line apart and charges it no tax", async ({ page }) => {
    await estimateFor(page, ADDRESS.lancaster, "Leaf raking");
    const rows = page.getByRole("table", { name: "Estimate breakdown" }).getByRole("row");
    await expect(rows).toHaveText([
      /Item\s*Amount/,
      /Leaf raking\s*Not taxable\s*\$65\.00/,
      /Subtotal\s*\$65\.00/,
      /Sales tax \(Lancaster County, 6%\): no taxable services\s*\$0\.00/,
      /Estimated total\s*\$65\.00/,
    ]);
  });

  test("carries the server's assumptions, and Allegheny's rate", async ({ page }) => {
    await estimateFor(page, ADDRESS.pittsburgh);
    await expect(page.locator(".lq-assumptions")).toHaveText(
      "Lot size 13,000 sq ft, from county tax records, not a survey. Includes the house footprint.",
    );
    await expect(page.getByRole("rowheader", { name: "Sales tax (Allegheny County, 7%)" })).toBeVisible();
  });
});

test.describe("lead form", () => {
  test.beforeEach(async ({ page }) => {
    await estimateFor(page, ADDRESS.lancaster);
    await expect(page.getByRole("heading", { level: 1, name: "Your estimate" })).toBeVisible();
  });

  test("names its inputs' purpose and sends the lead with the quote token", async ({ page }) => {
    await expect(page.getByLabel("Name")).toHaveAttribute("autocomplete", "name");
    await expect(page.getByLabel("Phone")).toHaveAttribute("autocomplete", "tel");
    await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "email");

    await page.getByLabel("Name").fill("  Pat Example ");
    await page.getByLabel("Phone").fill("717-555-0100");
    const submitted = page.waitForRequest("**/submit");
    await page.getByLabel("Phone").press("Enter");
    expect((await submitted).postDataJSON()).toEqual({
      token: "fx.lancaster-mow",
      contact: { name: "Pat Example", phone: "717-555-0100" },
      turnstile: "fixture-turnstile-token",
      embedOrigin: null,
    });

    await expect(page.getByRole("heading", { level: 1, name: "Request sent" })).toBeFocused();
    await expect(page.getByText("Nothing is booked or owed until then.")).toBeVisible();
    await expectAxeClean(page);
  });

  test("lists every problem in a focused summary whose links go to the fields", async ({ page }) => {
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: "Request service" }).click();
    const summary = alertIn(page);
    await expect(summary).toBeFocused();
    await expect(summary.getByRole("heading")).toHaveText("There are 2 problems");
    await expect(summary.getByRole("link")).toHaveText(["Enter your name.", "Enter an email address like name@example.com."]);
    await expect(page.getByLabel("Name")).toHaveAccessibleDescription("Error: Enter your name.");
    await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
    await expectAxeClean(page);

    await summary.getByRole("link", { name: "Enter your name." }).click();
    await expect(page.getByLabel("Name")).toBeFocused();

    // Neither a phone nor an email is one problem, on the first of the two.
    await page.getByLabel("Name").fill("Pat Example");
    await page.getByLabel("Email").fill("");
    await page.getByRole("button", { name: "Request service" }).click();
    await expect(summary.getByRole("link")).toHaveText(["Enter a phone number or an email address."]);
    await expect(page.getByLabel("Phone")).toHaveAttribute("aria-invalid", "true");
  });

  test("hides the honeypot from people and from assistive technology", async ({ page }) => {
    const honeypot = page.locator("#lq-website");
    await expect(honeypot).toHaveAttribute("tabindex", "-1");
    await expect(page.getByRole("textbox", { name: "Website" })).toHaveCount(0);
    await expect(honeypot).not.toBeInViewport();
  });
});

test.describe("manual path", () => {
  test("requires a zip and a lot size, then prices from them", async ({ page }) => {
    await estimateFor(page, ADDRESS.nowhere);
    await expect(page.getByRole("heading", { level: 1, name: "Tell us about the lawn" })).toBeFocused();
    await expect(page.getByText("We couldn't find that address in county records.")).toBeVisible();
    await expectAxeClean(page);

    const zip = page.getByLabel("Zip code");
    await expect(zip).toHaveValue("17601"); // read from the address, not asked twice
    await expect(zip).toHaveAttribute("autocomplete", "postal-code");
    await zip.fill("");
    await page.getByRole("button", { name: "Get my estimate" }).click();
    const summary = alertIn(page);
    await expect(summary).toBeFocused();
    await expect(summary.getByRole("link")).toHaveText(["Enter the property's five-digit zip code.", "Choose the lot size."]);
    await expectAxeClean(page);
    await summary.getByRole("link", { name: "Choose the lot size." }).click();
    await expect(page.getByRole("radio", { name: "About ¼ acre" })).toBeFocused();

    await zip.fill("1760");
    await page.getByRole("radio", { name: "About ¼ acre" }).check();
    await page.getByRole("button", { name: "Get my estimate" }).click();
    await expect(summary.getByRole("link")).toHaveText(["Enter the property's five-digit zip code."]);

    await zip.fill("17601");
    const request = page.waitForRequest("**/estimate");
    await page.getByRole("button", { name: "Get my estimate" }).click();
    expect((await request).postDataJSON()).toEqual({
      company: "joes-lawn",
      address: ADDRESS.nowhere,
      service: "mow",
      manual: { zip: "17601", size: { kind: "bucket", bucket: "quarter_acre" } },
      turnstile: "fixture-turnstile-token",
      embedOrigin: null,
    });

    await expect(page.getByRole("heading", { level: 1, name: "Your estimate" })).toBeFocused();
    await expect(page.locator(".lq-price-amount")).toHaveText("$47.70");
    await expect(page.locator(".lq-assumptions")).toHaveText("From the lot size you chose.");
    await expect(page.getByRole("rowheader", { name: "Sales tax (Lancaster County, 6%)" })).toBeVisible();
    // No parcel was measured: nothing to adjust, no parcel wording, no parcel credit.
    await expect(page.getByRole("group", { name: "Does that lawn size look right?" })).toHaveCount(0);
    await expect(page.locator(".lq-disclaimer")).toContainText("from the lot size you gave");
    await expect(page.getByText("Regrid")).toHaveCount(0);
    await expectAxeClean(page);
  });

  test("takes a typed lawn area within the contract's bounds", async ({ page }) => {
    await estimateFor(page, ADDRESS.nowhere);
    await page.getByRole("radio", { name: "I know the lawn area in square feet" }).check();
    const area = page.getByRole("textbox", { name: "Lawn area in square feet" });
    await area.fill("50");
    await page.getByRole("button", { name: "Get my estimate" }).click();
    await expect(alertIn(page).getByRole("link")).toHaveText([
      "Enter the lawn area as a whole number from 100 to 2,000,000 square feet.",
    ]);

    await area.fill("6,000");
    const request = page.waitForRequest("**/estimate");
    await page.getByRole("button", { name: "Get my estimate" }).click();
    expect((await request).postDataJSON().manual).toEqual({ zip: "17601", size: { kind: "sqft", sqft: 6000 } });
  });

  test("asks which county when the zip spans two tax rates, and prices at the one chosen", async ({ page }) => {
    await estimateFor(page, ADDRESS.philadelphia);
    await expect(page.getByText("We found more than one property at that address.")).toBeVisible();
    await expect(page.getByLabel("Zip code")).toHaveValue("19128");
    await page.getByRole("radio", { name: "About ¼ acre" }).check();
    await page.getByRole("button", { name: "Get my estimate" }).click();

    await expect(page.getByRole("heading", { level: 1, name: "Which county is the property in?" })).toBeFocused();
    await expect(page.getByText("Zip code 19128 covers more than one county")).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(2);
    // The question is where the property is; no rate is shown to choose by.
    await expect(page.getByText("%")).toHaveCount(0);
    await expectAxeClean(page);

    await page.getByRole("button", { name: "Continue" }).click();
    const summary = alertIn(page);
    await expect(summary).toBeFocused();
    await expect(summary).toContainText("Choose the county the property is in.");

    // Back keeps what was entered.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Tell us about the lawn" })).toBeFocused();
    await expect(page.getByText("We found more than one property at that address.")).toBeVisible();
    await expect(page.getByLabel("Zip code")).toHaveValue("19128");
    await expect(page.getByRole("radio", { name: "About ¼ acre" })).toBeChecked();
    await page.getByRole("button", { name: "Get my estimate" }).click();

    await page.getByRole("radio", { name: "Philadelphia County" }).check();
    const request = page.waitForRequest("**/estimate");
    await page.getByRole("button", { name: "Continue" }).click();
    expect((await request).postDataJSON().manual).toEqual({
      zip: "19128",
      size: { kind: "bucket", bucket: "quarter_acre" },
      county: "Philadelphia",
    });
    await expect(page.locator(".lq-price-amount")).toHaveText("$48.60");
    await expect(page.getByRole("rowheader", { name: "Sales tax (Philadelphia County, 8%)" })).toBeVisible();
  });

  test("asks the homeowner to call when the zip has no county, rather than guess a rate", async ({ page }) => {
    await estimateFor(page, ADDRESS.nowhere);
    await page.getByLabel("Zip code").fill("17000");
    await page.getByRole("radio", { name: "About ½ acre" }).check();
    await page.getByRole("button", { name: "Get my estimate" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Please call for a quote" })).toBeFocused();
    await expect(page.getByText("We couldn't work out the sales tax county")).toBeVisible();
    await expect(page.getByText("$")).toHaveCount(0);
  });
});

test.describe("when no estimate can be shown", () => {
  test("outside the service area: the company's phone number", async ({ page }) => {
    await estimateFor(page, ADDRESS.delaware);
    await expect(page.getByRole("heading", { level: 1, name: "Please call for a quote" })).toBeFocused();
    await expect(page.getByRole("link", { name: "Call (717) 555-0142" })).toHaveAttribute("href", "tel:7175550142");
    await expectAxeClean(page);
    await page.getByRole("button", { name: "Try another address" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Get an instant lawn estimate" })).toBeFocused();
    // The boxes still hold what was typed.
    await expect(page.getByLabel("Street address")).toHaveValue("500 Market St");
    await expect(page.getByLabel("State")).toHaveValue("DE");
  });

  test("an API error is announced beside the button, and the form can be sent again", async ({ page, problems }) => {
    await page.route("**/api/fixtures/estimate", (route) => route.fulfill(recordedError("rate_limited")), { times: 1 });
    await estimateFor(page, ADDRESS.lancaster);
    const alert = alertIn(page);
    await expect(alert).toHaveText("Too many requests just now. Wait a minute and try again.");
    await expect(page.getByRole("button", { name: "Get my estimate" })).not.toHaveAttribute("aria-disabled", "true");
    await expectAxeClean(page);
    problems.length = 0; // the 429 itself

    await page.getByRole("button", { name: "Get my estimate" }).click();
    await expect(page.locator(".lq-price-amount")).toHaveText("$50.88");
    await expect(alert).toHaveCount(0);
  });

  test("an expired quote token sends the homeowner back to start, saying why", async ({ page, problems }) => {
    await estimateFor(page, ADDRESS.lancaster);
    await page.route("**/api/fixtures/submit", (route) => route.fulfill(recordedError("token_expired")));
    await page.getByLabel("Name").fill("Pat Example");
    await page.getByLabel("Email").fill("pat@example.com");
    await page.getByRole("button", { name: "Request service" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Get an instant lawn estimate" })).toBeFocused();
    await expect(alertIn(page)).toHaveText("That estimate has expired. Please start again.");
    await expect(page.getByLabel("Street address")).toHaveValue("412 Maple Ave");
    await expect(page.getByLabel("Zip code")).toHaveValue("17601");
    problems.length = 0;
  });

  test("a dropped connection is reported, not swallowed", async ({ page, problems }) => {
    await page.route("**/api/fixtures/estimate", (route) => route.abort("connectionfailed"));
    await estimateFor(page, ADDRESS.lancaster);
    await expect(alertIn(page)).toHaveText("We couldn't reach the server. Check your connection and try again.");
    problems.length = 0;
  });

  test("an origin the company has not allowed is told so", async ({ page, problems }) => {
    await page.route("**/api/fixtures/estimate", (route) => route.fulfill(recordedError("origin_not_allowed")));
    await estimateFor(page, ADDRESS.lancaster);
    await expect(alertIn(page)).toContainText("This quote form isn't set up for this website yet.");
    problems.length = 0;
  });
});

test.describe("theming and layout", () => {
  test("a dark brand color fills the button under white text", async ({ page }) => {
    const button = page.getByRole("button", { name: "Get my estimate" });
    await expect(button).toHaveCSS("background-color", "rgb(31, 111, 67)");
    await expect(button).toHaveCSS("color", "rgb(255, 255, 255)");
  });

  test("a light brand color gets dark text and a dark edge, and still passes axe", async ({ page }) => {
    await page.goto("/w/sunny-yards");
    const button = page.getByRole("button", { name: "Get my estimate" });
    await expect(button).toHaveCSS("background-color", "rgb(255, 210, 0)");
    await expect(button).toHaveCSS("color", "rgb(27, 31, 29)");
    await expect(button).toHaveCSS("border-top-color", "rgb(27, 31, 29)");
    // One service: stated, not asked.
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByText(MOWING)).toBeVisible();
    await expectAxeClean(page);
  });

  test("reflows at 320 px and keeps touch targets at 44 px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await fits()).toBe(true);

    for (const target of await page.locator(".lq-input").all()) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await estimateFor(page, ADDRESS.pittsburgh);
    await expect(page.locator(".lq-price-amount")).toBeVisible();
    expect(await fits()).toBe(true);
    await expectAxeClean(page);

    for (const target of await page.locator(".lq-chip, .lq-button, .lq-input").all()) {
      const box = (await target.boundingBox())!;
      expect(box.height, await target.evaluate((el) => el.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Change address" }).click();
    for (const target of await page.locator(".lq-radio").all()) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("shows a visible focus ring in the fixed focus color", async ({ page }) => {
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toHaveAttribute("type", "radio");
    await expect(page.locator(".lq-radio", { has: focused })).toHaveCSS("outline", "rgb(11, 87, 208) solid 3px");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Street address")).toBeFocused();
    await expect(page.getByLabel("Street address")).toHaveCSS("outline", "rgb(11, 87, 208) solid 3px");
  });
});

test.describe("the page and its headers", () => {
  test("ships no inline script and a policy that would not run one", async ({ page, request }) => {
    const response = await request.get("/w/joes-lawn");
    const csp = response.headers()["content-security-policy"]!;
    expect(csp.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "style-src-attr 'unsafe-inline'",
      "img-src 'self'",
      "connect-src 'self'",
      "frame-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self' https://joeslawn.example http://host.localhost:3102",
    ]);
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");

    // The only script element without a src is Next's JSON data block, which is not executed.
    const inline = await page.locator("script:not([src])").evaluateAll((scripts) => scripts.map((s) => s.getAttribute("type")));
    expect(inline).toEqual(["application/json"]);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle("Instant lawn quote from Joe's Lawn Care");
    // The whole flow ran in other tests with no console error; `problems` fails this one if the policy blocks anything here.
  });

  test("the server's markup already has the form and the brand color", async ({ request }) => {
    const html = await (await request.get("/w/joes-lawn")).text();
    expect(html).toContain("Get an instant lawn estimate");
    expect(html).toContain("--lq-btn-bg:#1f6f43");
    // Escaped wherever it appears in markup.
    expect(html).toContain("Joe&#x27;s Lawn Care");
  });

  test("an allowlist of nothing lets any site embed the widget", async ({ request }) => {
    const csp = (await request.get("/w/sunny-yards")).headers()["content-security-policy"]!;
    expect(csp).toMatch(/; frame-ancestors \*$/);
  });

  test("an unknown company is a 404 that cannot be framed either", async ({ request }) => {
    for (const path of ["/w/no-such-company", "/w/Not%20A%20Slug"]) {
      const response = await request.get(path);
      expect(response.status()).toBe(404);
      expect(response.headers()["content-security-policy"]).toMatch(/frame-ancestors 'self'$/);
    }
    const other = await request.get("/anything-else");
    expect(other.status()).toBe(404);
    expect(other.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
  });

  test("the fixture API answers bad input as the contract says, and rates never reach the browser", async ({ request }) => {
    const bad = await request.post("/api/fixtures/estimate", { data: { company: "joes-lawn", address: "x" } });
    expect(bad.status()).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_request" } });

    const good = await request.post("/api/fixtures/estimate", {
      data: { company: "joes-lawn", address: ADDRESS.lancaster, service: "mow", turnstile: "t", embedOrigin: null },
    });
    expect(good.headers()["cache-control"]).toBe("no-store");
    const text = await good.text();
    for (const leaked of ["tier", "pricePer", "regionGroup", "minCharge", "coverage"]) expect(text).not.toContain(leaked);
  });
});
