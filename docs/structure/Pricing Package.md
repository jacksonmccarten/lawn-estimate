---
tags: [structure, package]
workspace: "@lq/pricing"
path: packages/pricing
---

# Pricing package

`packages/pricing` is one file, `src/index.ts`, exporting `priceQuote(input)` and its types. It is the only place a price is computed, and it is pure: no I/O, no clock, no randomness, inputs never mutated, every intermediate value an integer. Design: [[ENGINEERING_DESIGN#8. Pricing engine|§8]] and the "Pricing engine shape" row of the Decisions table. Requirements R1–R4 and R20 in [[COMPLIANCE_REQUIREMENTS]].

The `/estimate` Lambda, the owner route `POST /pricing-versions/{id}/preview` and the dashboard's mock all call it, so a homeowner's estimate and an owner's preview can never disagree. It has no dependencies.

## Shape

```ts
priceQuote({ version, serviceCode, addOnCodes?, grassSqft, regionGroup, taxRateBps })
  → { ok: true, quote }                                    // lines, subtotal, taxable subtotal, tax, total, versionId
  | { ok: false, reason: "unknown_service", serviceCode }  // the version does not sell this service
  | { ok: false, reason: "no_tier", serviceCode }          // no tier covers this size in this region: "call us"
```

| Type | Holds |
| --- | --- |
| `Service` | `code`, `name`, `taxable` (R1) |
| `Tier` | `serviceCode`, `regionGroup`, `minSqft`, `maxSqft`, and exactly one of `pricePerSqftMicrocents` or `flatPriceCents` |
| `PricingVersion` | `id`, `minChargeCents`, `services[]`, `tiers[]` |
| `PricingInput` | the version, the quoted service, optional add-on codes, `grassSqft`, `regionGroup`, `taxRateBps` |
| `QuoteLine` | `serviceCode`, `name`, `amountCents`, `taxable` |
| `Quote` | `lines[]`, `subtotalCents`, `taxableSubtotalCents`, `taxRateBps`, `taxCents`, `totalCents`, `versionId` |

## Rules it enforces

- A tier covers `minSqft < grassSqft <= maxSqft` for one service in one region group.
- Per-square-foot rates are microcents (millionths of a cent): `$0.0075/sqft` is `750_000`. Labor is `grassSqft × rate / 1,000,000`, rounded half up. A flat tier is its flat price.
- The minimum charge applies to the quoted service's line only (`max(minCharge, labor)`), so it is taxed as that service is. Add-ons are their own lines, each from its own tier.
- Lines are never merged (R2, R3). Tax is computed once, on the taxable subtotal, at `taxRateBps / 10,000` (600 is 6%), rounded half up (R4). The rate is never defaulted; the caller looks it up from the county.
- Input that can only come from a bug (a negative or non-integer number, a service requested twice, a tier with neither price, a rate of 100% or more) throws `RangeError`. The two cases a caller must handle come back as `{ ok: false }`.

Money is integer cents here and in the database; formatting happens only in the front ends.

## How the dashboard uses it

The pricing editor ([[Dashboard App]]) offers lawn-size categories with one flat rate each for the mowing service. It writes them as flat tiers (`flatPriceCents`, contiguous ranges, the last open-ended at 1,000,000,000 sq ft) in every region group the company has, so the engine and the contract are unchanged and per-square-foot pricing or more services can return later.

## Tests

`test/pricing.test.ts` (Vitest) is table-driven: every tier boundary, the minimum-charge edge, the separately-stated tax rule, rounding, and the no-tier and unknown-service cases. `npm test -w @lq/pricing`.

Related: [[API Contract Package]] (`QuoteTotals`, the wire shape of a quote), [[Data Model]] (`pricing_versions`, `services`, `pricing_tiers`), [[Lambdas]].
