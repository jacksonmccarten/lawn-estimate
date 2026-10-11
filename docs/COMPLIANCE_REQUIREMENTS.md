---
tags: [compliance]
---

# Compliance & Licensing Requirements

2026-10-10 · Companion: `ENGINEERING_DESIGN.md`

This document collects every legal, tax and licensing requirement the product must satisfy to launch in Pennsylvania, so the engineering design can treat them as fixed inputs. It assumes the agreed stack: AWS Amplify, Cognito, Lambda, Aurora PostgreSQL with RLS, Regrid for parcels; no map provider in the MVP. Pricing comes only from each company's own rate table; no model is trained on any data.

Each requirement is restated as a testable line in the checklist at the end. Items marked **verify** need a Pennsylvania attorney or a written vendor confirmation before launch. This is engineering and product guidance, not legal advice.

## 1. Pennsylvania sales tax on lawn care services

Mowing and most lawn maintenance are taxable services in Pennsylvania under 61 Pa. Code § 55.6; landscaping, planting and bed maintenance are not. The quote engine must carry a taxable flag per service and show taxable and non-taxable lines separately. A 2001 House bill to repeal the tax died in the Senate; the regulation stands.

| Service | Taxable in PA | Notes |
| --- | --- | --- |
| Mowing, trimming, cutting, edging | Yes | Core mowing product |
| Fertilizing, liming, watering, raking grass | Yes | |
| Dethatching, aerating, overseeding, sodding an existing lawn | Yes | |
| Herbicide, insecticide, fungicide on lawns | Yes | |
| Shrub trimming or pruning done with other lawn work | Yes | Standalone shrub work is not |
| Lawn evaluation or soil testing bought with other lawn services | Yes | Standalone is not |
| Seeding or sodding a new lawn | No | Presumed new when tied to construction |
| Tree trimming, pruning, fertilizing, planting, removal | No | |
| Planting or removing shrubbery | No | |
| Landscape or lawn design | No | |
| Flower or vegetable bed maintenance (mulch, till, weed, fertilize) | No | |
| Leaf raking, separately stated | No | Bundled with mowing it becomes taxable |
| Snow removal | Not addressed by § 55.6 | **verify** before the winter product |

The separately-stated rule is the trap: if taxable and non-taxable charges appear on one invoice without being itemized, tax applies to the whole invoice. The rate is 6% statewide, 7% in Allegheny County, 8% in Philadelphia, determined by where the service is performed. Charitable, religious, educational and government purchasers are exempt; the regulation draws no residential-versus-commercial line.

Requirements that follow:

- Every service row carries `taxable: boolean`, defaulting from a seeded PA service list.
- A quote stores line items, each with its own amount and taxable flag; the quote screen and any emailed summary show them as separate lines with tax computed only on the taxable subtotal.
- The tax rate is looked up from the service address's county (and Philadelphia city), stored on the quote with the pricing version.
- Bundled packages ("mow + mulch beds") are stored and displayed as their component lines, never as one price.

## 2. Pennsylvania HICPA

The Home Improvement Consumer Protection Act regulates contracts for home improvement work over $500 and requires contractors to register with the Attorney General's Bureau of Consumer Protection. Landscaping work is generally read as home improvement; routine mowing is maintenance and generally is not (**verify** both with a PA attorney). Our quote is an estimate and must never function as the contract.

A HICPA-compliant contract must be in writing, signed by all parties, and include: the contractor's registration number, insurance and contact information; a detailed description of work and materials; an itemized price, deposit receipts and payment schedule; the transaction date and approximate start and end dates; the Bureau's toll-free number; a notice of the right to rescind within three business days; and a rule that changes need a written change order.

Requirements that follow:

- The homeowner quote screen is labeled an estimate, carries no signature or acceptance of terms, and the call to action is "request service", not "accept".
- The company profile has an optional HIC registration number field; when present it is shown on quotes for non-taxable landscaping services, as a trust signal.
- Any future "accept and sign" step for landscaping jobs over $500 is a separate feature that renders every HICPA element above.
- Mowing-only quotes are unaffected, pending the attorney's confirmation.

## 3. Our own obligations in Pennsylvania

Form an LLC, register for a PA sales tax license, and run a trademark search, in that order and before the first paid invoice.

- **Entity:** a Pennsylvania LLC before taking any card payment; the design-partner month can run under a free arrangement first.
- **SaaS sales tax:** Pennsylvania taxes SaaS subscriptions. Register with the Department of Revenue and turn on Stripe Tax from the first invoice. Rate follows the customer's location: 6%, 7% Allegheny, 8% Philadelphia.
- **Trademark:** search the product name at the USPTO and the PA Department of State before printing a QR code on anyone's truck.
- **Privacy law:** Pennsylvania has no comprehensive consumer privacy statute as of this writing; a standard privacy policy plus the Breach of Personal Information Notification Act's breach-notice duty is the baseline (**verify** that no PA bill has passed since).

## 4. Regrid API and Tiles terms

> Retired with engineering design rev 2.4: Regrid is no longer called, on cost. This section stands for the parcel records already cached and until the Regrid code is removed.

Regrid's API and Tiles Terms let us cache parcel records and display tiles in any interactive map, but forbid caching tiles or geometry offline and require that cached records be destroyed if the agreement ends.

| Term | What it means for us |
| --- | --- |
| Parcel records may be cached and stored | `parcel_cache` table keyed by Regrid parcel id; a cache, not a system of record |
| Cached records must be destroyed on termination or on notice | `parcel_cache` must be truncatable without breaking any quote; quotes never foreign-key into it |
| Tiles and geometries may not be cached offline without written approval | Property-line tiles (P2) are streamed at view time, never downloaded or proxied to disk |
| Geometry may be extracted for web and mobile applications; other derivative works need approval | Our use is the allowed case; no bulk export, no republished layer |
| Tiles may be shown on Leaflet, Mapbox, Esri or other interactive maps | MapLibre (P2) is covered as "other interactive map" |
| No AI training on the data | Matches our own no-training commitment |
| No product with substantially similar features | We sell quotes, not parcel data; never expose a parcel-search feature |
| Enterprise licensing above 10,000 records per month | Alert at 8,000 lookups per month; talk to Regrid before crossing |

The estimate the homeowner confirms is stored as our own quote record (`quotes.grass_sqft`, `origin`), not a copy of Regrid's parcel, and survives if we ever leave Regrid. Plan prices are behind the login at app.regrid.com/api/plans and must be checked before launch; the sandbox is free for 30 days.

## 5. Mapbox and imagery terms

Since engineering design rev 2.4 the MVP uses Mapbox: the homeowner's address is geocoded and a static satellite photo shown, and the homeowner outlines the lawn on it. That makes the first item below a launch blocker.

- **Tracing exposure.** Mapbox's terms have historically limited tracing its satellite imagery into derivative vector data to non-commercial and OpenStreetMap use. Get written confirmation from Mapbox that homeowner-adjusted polygons over its imagery are permitted on a standard plan (**verify**), or use imagery with no tracing restriction.
- **Fallback imagery.** Pennsylvania's PEMA orthoimagery (6-inch, statewide, cleared as public domain by PASDA; flown 2018–2020) and USDA NAIP (public domain, ~60 cm) can be the base layer in the drawing step. Check PASDA for a newer PEMA cycle.
- **Geocode storage.** Mapbox temporary geocoding results may not be stored permanently; nothing from a geocoding answer is kept. Only the position is read, in the browser, to aim the photo; the zip on a quote is the one the homeowner typed, and only the outline's area reaches our API.
- **Attribution.** Mapbox wordmark and attribution on every photo (drawn into the static image; never cropped or covered), and a text credit under it.
- **Google Maps Platform** is not used anywhere. Its terms forbid creating content from its imagery and forbid use with non-Google maps.

## 6. Open data and software licences in the stack

| Component | Licence | Obligation |
| --- | --- | --- |
| React Aria Components / Radix | Apache 2.0 / MIT | Keep licence notices |
| Turf.js (P2) | MIT | Keep licence notice |
| MapLibre GL JS (P2) | BSD-3 | Keep licence notice |
| mapbox-gl-draw (P2) | ISC | Keep licence notice |
| Regrid parcels, footprints add-on | Proprietary API/Tiles terms | Section 4 |
| Mapbox APIs (geocoding, static images) | Proprietary service terms | Section 5 |
| Google Open Buildings (if used instead of Regrid footprints) | CC BY 4.0 | Attribution in data credits |
| Microsoft or Overture building footprints | ODbL | Not used; share-alike would attach to a merged database |
| PASDA county parcels and PEMA imagery | Public records / public domain per PASDA | Per-dataset use constraints; attribution |
| USDA NAIP imagery | Public domain | None |

Nothing in the stack is copyleft, so application code stays ours.

## 7. Our own legal documents

| Document | Audience | Must contain |
| --- | --- | --- |
| Terms of service | Company (subscriber) | Subscription and billing terms; acceptable use; limitation of liability for measurement and pricing errors; rate tables are the company's confidential data; no training or cross-tenant benchmarking on their data; data-processing clause (we process their customers' data on their instructions and delete on request) |
| Estimate disclaimer | Homeowner, on the quote screen | "This is an estimate from the lawn you outlined on an aerial photo, using [Company]'s published rates. [Company] confirms the final price before work begins." The area is labeled as measured on an aerial photo, not a survey |
| Privacy policy | Homeowner | What we collect (address, contact details, estimated yard size), why (to produce and deliver the quote to the company they chose), who sees it (that company only; the address is also sent to Mapbox, from the homeowner's browser, to find the property and show its photo), retention, no sale of leads, no model training, how to request deletion |
| Data credits | Everyone, in the app footer | Regrid and any open-data attribution required above |

No document uses the word "waiver"; nothing here waives a homeowner's rights, and HICPA would not permit it for covered work.

## 8. Requirements checklist

Owner: Engine, UI, Data, Legal, Ops. Status: Not started, In progress, Done, Needs verify.

| # | Requirement | Owner | Status |
| --- | --- | --- | --- |
| R1 | Every service row has a `taxable` flag, seeded from the PA list above | Engine | Not started |
| R2 | A quote stores line items with amount and taxable flag; tax is computed only on the taxable subtotal | Engine | Not started |
| R3 | The quote screen and emailed summary show taxable and non-taxable lines separately, never one bundled price | UI | Not started |
| R4 | Tax rate is looked up from the service address's county (6% / 7% Allegheny / 8% Philadelphia) and stored on the quote | Engine | Not started |
| R5 | Snow removal taxability confirmed before the winter product ships | Legal | Needs verify |
| R6 | Quote screen is labeled an estimate; CTA is "request service"; no acceptance of terms or signature | UI | Not started |
| R7 | Company profile has an optional HIC registration number, shown on non-taxable landscaping quotes | UI | Not started |
| R8 | Any future accept-and-sign step for jobs over $500 renders every HICPA element, scoped as its own feature | UI | Not started |
| R9 | HICPA coverage of landscaping vs. mowing confirmed by a PA attorney | Legal | Needs verify |
| R10 | `parcel_cache` is a standalone table; quotes never foreign-key into it; it can be truncated without breaking a quote | Data | Not started |
| R11 | (P2) Property-line tiles are streamed from Regrid at view time; nothing proxies or caches them to disk | Data | Not started |
| R12 | Quotes store the confirmed estimate (`grass_sqft`, `origin`) as our own record, independent of the parcel cache | Data | Not started |
| R13 | Retired with Regrid. In its place: the Mapbox public token is restricted to our origins, and usage is watched in the Mapbox account | Ops | Not started |
| R14 | No parcel-search or parcel-browse feature is exposed to any user | UI | Not started |
| R15 | Written confirmation from Mapbox that homeowner-drawn lawn outlines over its imagery are permitted, or the drawing step uses PEMA/NAIP imagery. Blocks launch since rev 2.4 | Legal | Needs verify |
| R16 | Mapbox geocoding results are not persisted: only the position is read, in the browser, and neither it nor the outline's geometry is sent to our API | Data | Built (widget) |
| R17 | Mapbox and imagery attribution visible on every aerial photo; data credits page lists all open-data sources | UI | Built on the photo; credits page not started |
| R18 | No ODbL dataset is merged into our database | Data | Not started |
| R19 | Company ToS, estimate disclaimer, privacy policy and data credits drafted and linked from the app | Legal | Not started |
| R20 | Privacy policy and ToS both state: no model training, no cross-tenant benchmarking, no sale of leads | Legal | Not started |
| R21 | A lawn area from the aerial photo is labeled "measured on an aerial photo, not a survey"; a lot size from tax records, where one is still shown, "from county tax records, not a survey" | UI | Built (widget) |
| R22 | PA LLC formed, sales tax license obtained, Stripe Tax on, before the first paid invoice | Ops | Not started |
| R23 | Product name cleared at USPTO and PA Department of State before QR codes are printed | Ops | Not started |
| R24 | Address typeahead follows the WAI-ARIA combobox pattern and passes a keyboard-only pass and a VoiceOver pass on iOS | UI | Not applicable: the address is four labelled boxes with no typeahead. Applies again if one is added |
| R25 | Company brand color is contrast-checked at render time; text color is never company-set; buttons use the brand color only when it passes 4.5:1 | UI | Not started |
| R26 | Price, adjustment and error states are announced (aria-live, role=alert); the iframe has a title; the widget reflows at 320 px and re-sizes after 200% zoom | UI | Not started |
| R27 | axe-core runs in CI on every widget and dashboard page; no WCAG 2.2 AA claim is published until the keyboard and screen-reader passes are complete | Ops | Not started |
| R28 | Dashboard tables use real table markup with scoped headers, aria-sort on sortable columns, keyboard-reachable row actions, and status conveyed by text, not color alone | UI | Not started |
| R29 | Dashboard forms and dialogs: labels with units, inline errors linked by aria-describedby plus a focusable error summary, dialogs that trap and return focus, tier reordering by buttons as well as drag | UI | Not started |
| R30 | Publishing a pricing version is a two-step confirm with a diff and a rollback path (WCAG 3.3.4); forced sign-out is preceded by a 2-minute warning with form state preserved (2.2.1) | UI | Not started |
| R31 | Front-end standards in place before UI work starts: accessible component library, contrast-checked design tokens, jsx-a11y lint, axe in Storybook and Playwright CI, accessibility definition of done in the PR template | UI | Not started |

## 9. Sources and verification notes

The sales tax regulation and the Regrid terms were read directly; HICPA and the imagery terms come from secondary summaries and vendor pages, which is why those items are marked **verify**.

- 61 Pa. Code § 55.6, Lawn care services (read in full): https://law.cornell.edu/regulations/pennsylvania/61-Pa-Code-SS-55-6
- 2001 repeal bill that did not pass: https://www.lawnandlandscape.com/news/pennsylvania-closer-to-removing-lawn-care-sales-taxes
- HICPA overview (secondary; attorney to confirm): https://cornerstonelaw.us/pennsylvanias-home-improvement-consumer-protection-act/
- Regrid API and Tiles Terms of Service (read in full): https://regrid.com/terms/api
- Regrid API overview and self-serve plans (prices behind login): https://regrid.com/api · https://regrid.com/blog/introducing-regrids-updated-self-serve-api
- Mapbox Terms of Service: https://www.mapbox.com/legal/tos · imagery sources: https://docs.mapbox.com/help/dive-deeper/imagery/
- PEMA Orthoimagery (OSM wiki): https://wiki.openstreetmap.org/wiki/Pennsylvania/PEMA_Orthoimagery · PASDA catalog: https://geo.btaa.org/catalog/pasda-5104
- PASDA PA_Parcels statewide service: https://apps.pasda.psu.edu/arcgis/rest/services/PA_Parcels_Vector/MapServer/layers

Outstanding before launch: attorney review of R8 and R9; Regrid plan pricing; snow removal taxability (R5); whether PEMA has flown a cycle newer than 2020 (P2 only).
