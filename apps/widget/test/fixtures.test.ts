// The fixtures stand in for Lambdas that do not exist yet, so the contract is
// the only thing keeping them honest: every recorded request and response
// must parse, and every priced response must add up.

import { ErrorResponse, EstimateRequest, EstimateResponse, SubmitRequest, SubmitResponse } from "@lq/api-contract";
import { describe, expect, it } from "vitest";
import {
  errorRecordings,
  estimateKey,
  estimateRecordings,
  replayEstimate,
  replaySubmit,
  submitRecordings,
} from "../src/server/fixtures";

const ALLOWED = ["https://joeslawn.example"];
const common = { turnstile: "fixture-turnstile-token", embedOrigin: null };

describe("recorded fixtures", () => {
  it.each(estimateRecordings.map((r) => [r.name, r] as const))("estimate %s matches the contract", (_name, recording) => {
    expect(EstimateRequest.safeParse(recording.request).error).toBeUndefined();
    expect(EstimateResponse.safeParse(recording.response).error).toBeUndefined();
  });

  it.each(submitRecordings.map((r) => [r.name, r] as const))("submit %s matches the contract", (_name, recording) => {
    expect(SubmitRequest.safeParse(recording.request).error).toBeUndefined();
    expect(SubmitResponse.safeParse(recording.response).error).toBeUndefined();
  });

  it.each(errorRecordings.map((r) => [r.name, r] as const))("error %s matches the contract", (_name, recording) => {
    expect(ErrorResponse.safeParse(recording.body).error).toBeUndefined();
    expect(recording.httpStatus).toBeGreaterThanOrEqual(400);
  });

  it("have unique names and unique request keys", () => {
    const names = estimateRecordings.map((r) => r.name);
    const keys = estimateRecordings.map((r) => estimateKey(r.request));
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("price the way packages/pricing does: tax on the taxable subtotal only, rounded half up", () => {
    for (const { name, response } of estimateRecordings) {
      if (response.status !== "priced") continue;
      const { quote } = response;
      const sum = (lines: typeof quote.lines) => lines.reduce((total, line) => total + line.amountCents, 0);
      expect(quote.subtotalCents, name).toBe(sum(quote.lines));
      expect(quote.taxableSubtotalCents, name).toBe(sum(quote.lines.filter((line) => line.taxable)));
      expect(quote.taxCents, name).toBe(Math.floor((quote.taxableSubtotalCents * quote.taxRateBps + 5000) / 10000));
      expect(quote.totalCents, name).toBe(quote.subtotalCents + quote.taxCents);
    }
  });

  it("apply Pennsylvania's rates by county", () => {
    for (const { name, response } of estimateRecordings) {
      if (response.status !== "priced") continue;
      const expected = response.county === "Allegheny" ? 700 : response.county === "Philadelphia" ? 800 : 600;
      expect(response.quote.taxRateBps, name).toBe(expected);
    }
  });

  it("allow one adjustment: every adjustable estimate has both adjustments recorded, and neither can be adjusted again", () => {
    for (const { name, response } of estimateRecordings) {
      if (response.status !== "priced" || !response.canAdjust) continue;
      for (const adjust of ["smaller", "larger"] as const) {
        const reply = replayEstimate({ token: response.token, adjust, ...common }, null);
        expect(reply.httpStatus, `${name} ${adjust}`).toBe(200);
        expect(reply.body, `${name} ${adjust}`).toMatchObject({ status: "priced", origin: "regrid_adjusted", canAdjust: false });
      }
    }
  });
});

describe("replayEstimate", () => {
  const first = { company: "joes-lawn", service: "mow", ...common };

  it("matches an address whatever its case and punctuation", () => {
    const reply = replayEstimate({ ...first, address: "412 maple ave  lancaster PA 17601" }, ALLOWED);
    expect(reply.body).toMatchObject({ status: "priced", token: "fx.lancaster-mow" });
  });

  it("answers an unrecorded address as no match, never with a made-up price", () => {
    const reply = replayEstimate({ ...first, address: "9 Unrecorded Way, York, PA 17401" }, ALLOWED);
    expect(reply.body).toEqual({ status: "manual_required", reason: "no_match" });
  });

  it("asks for a county when the zip has two rates, then prices at the chosen one", () => {
    const manual = { zip: "19128", size: { kind: "bucket", bucket: "half_acre" } } as const;
    const address = "7 Ridge Ave, Philadelphia, PA 19128";
    expect(replayEstimate({ ...first, address, manual }, ALLOWED).body).toEqual({
      status: "county_required",
      zip: "19128",
      candidates: ["Philadelphia", "Montgomery"],
    });
    expect(replayEstimate({ ...first, address, manual: { ...manual, county: "Philadelphia" } }, ALLOWED).body).toMatchObject({
      status: "priced",
      county: "Philadelphia",
    });
    expect(replayEstimate({ ...first, address, manual: { ...manual, county: "Montgomery" } }, ALLOWED).body).toMatchObject({
      status: "priced",
      county: "Montgomery",
    });
  });

  it("asks the homeowner to call when the zip has no county on file", () => {
    const reply = replayEstimate({ ...first, address: "1 Main St", manual: { zip: "00501", size: { kind: "sqft", sqft: 5000 } } }, ALLOWED);
    expect(reply.body).toMatchObject({ status: "call_us", reason: "unknown_county" });
  });

  it("refuses an embedding origin that is not on the company's list, and an unknown company", () => {
    const address = "412 Maple Ave, Lancaster, PA 17601";
    expect(replayEstimate({ ...first, address, embedOrigin: "https://joeslawn.example" }, ALLOWED).httpStatus).toBe(200);
    expect(replayEstimate({ ...first, address, embedOrigin: "https://evil.example" }, ALLOWED)).toMatchObject({
      httpStatus: 403,
      body: { error: { code: "origin_not_allowed" } },
    });
    expect(replayEstimate({ ...first, address }, null)).toMatchObject({ httpStatus: 404, body: { error: { code: "not_found" } } });
  });

  it("rejects a token it never issued", () => {
    expect(replayEstimate({ token: "forged", adjust: "smaller", ...common }, null)).toMatchObject({
      httpStatus: 400,
      body: { error: { code: "token_invalid" } },
    });
    expect(replaySubmit({ token: "forged", contact: { name: "A", phone: "717-555-0100" }, ...common })).toMatchObject({
      httpStatus: 400,
      body: { error: { code: "token_invalid" } },
    });
  });
});

describe("replaySubmit", () => {
  it("accepts any token an estimate issued, including an adjusted one", () => {
    const reply = replaySubmit({ token: "fx.lancaster-mow.smaller", contact: { name: "A", email: "a@example.com" }, ...common });
    expect(reply).toMatchObject({ httpStatus: 200, body: { status: "submitted" } });
  });
});
