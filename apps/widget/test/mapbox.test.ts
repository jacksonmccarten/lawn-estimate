import { describe, expect, it } from "vitest";
import { geocode, lawnSqft, pan, project, ringSqft, staticImageUrl, totalSqft, unproject, zoomBy, MAX_ZOOM, MIN_ZOOM, type LngLat, type View } from "../src/lib/mapbox";

// State College, PA.
const HOME: LngLat = { lng: -77.8600, lat: 40.7934 };
const view: View = { center: HOME, zoom: 19, width: 400, height: 400 };

const M_PER_DEG = 111_319.49;
/** A place `east` and `north` metres from HOME. */
const offset = (east: number, north: number): LngLat => ({
  lng: HOME.lng + east / (M_PER_DEG * Math.cos((HOME.lat * Math.PI) / 180)),
  lat: HOME.lat + north / M_PER_DEG,
});

describe("the photo's projection", () => {
  it("puts the view's center in the middle of the photo", () => {
    const middle = project(HOME, view);
    expect(middle.x).toBeCloseTo(200, 6);
    expect(middle.y).toBeCloseTo(200, 6);
  });

  it("takes a point to the ground and back", () => {
    for (const point of [{ x: 0, y: 0 }, { x: 37.5, y: 312.25 }, { x: 400, y: 400 }]) {
      const back = project(unproject(point, view), view);
      expect(back.x).toBeCloseTo(point.x, 6);
      expect(back.y).toBeCloseTo(point.y, 6);
    }
  });

  it("has north up and east to the right, at about 11 cm a pixel", () => {
    const northEast = project(offset(10, 10), view);
    expect(northEast.x).toBeGreaterThan(200);
    expect(northEast.y).toBeLessThan(200);
    // 10 m at zoom 19 and this latitude.
    expect(northEast.x - 200).toBeCloseTo(88.4, 0);
    expect(200 - northEast.y).toBeCloseTo(88.4, 0);
  });

  it("keeps an outline on the same ground when the photo is moved or zoomed", () => {
    const corner = offset(12, -7);
    const moved = pan(view, 0.4, 0);
    expect(project(corner, moved).x).toBeCloseTo(project(corner, view).x - 160, 6);
    const closer = zoomBy(view, 1);
    expect(project(corner, closer).x - 200).toBeCloseTo((project(corner, view).x - 200) * 2, 6);
  });

  it("stops zooming at its limits", () => {
    expect(zoomBy(view, 5).zoom).toBe(MAX_ZOOM);
    expect(zoomBy(view, -9).zoom).toBe(MIN_ZOOM);
  });
});

describe("outlined area", () => {
  const square = (side: number, east = 0): LngLat[] => [offset(east, 0), offset(east + side, 0), offset(east + side, side), offset(east, side)];

  it("measures a 30 m square as 900 square metres, whichever way it is wound", () => {
    const sqft = 900 * 10.7639104;
    expect(Math.abs(ringSqft(square(30)) - sqft) / sqft).toBeLessThan(0.002);
    expect(ringSqft([...square(30)].reverse())).toBeCloseTo(ringSqft(square(30)), 6);
  });

  it("counts nothing for fewer than three corners", () => {
    expect(ringSqft([])).toBe(0);
    expect(ringSqft(square(30).slice(0, 2))).toBe(0);
  });

  it("adds a front and a back yard and rounds to a whole square foot", () => {
    const total = totalSqft([square(30), square(10, 50)]);
    expect(Number.isInteger(total)).toBe(true);
    expect(Math.abs(total - 1000 * 10.7639104)).toBeLessThan(25);
  });
});

describe("lawn area from include and exclude outlines", () => {
  const box = (west: number, south: number, east: number, north: number): LngLat[] => [
    offset(west, south),
    offset(east, south),
    offset(east, north),
    offset(west, north),
  ];
  const SQFT = 10.7639104;
  const near = (got: number, sqm: number) => expect(Math.abs(got - sqm * SQFT)).toBeLessThan(sqm * SQFT * 0.002 + 1);

  it("is nothing without an include outline", () => {
    expect(lawnSqft([])).toBe(0);
    expect(lawnSqft([{ kind: "exclude", ring: box(0, 0, 10, 10) }])).toBe(0);
    expect(lawnSqft([{ kind: "include", ring: box(0, 0, 10, 10).slice(0, 2) }])).toBe(0);
  });

  it("measures one include outline like ringSqft", () => {
    near(lawnSqft([{ kind: "include", ring: box(0, 0, 30, 30) }]), 900);
  });

  it("counts overlapping include outlines once", () => {
    // Two 20 x 20 squares overlapping by 10 x 20: 600 m², not 800.
    near(lawnSqft([{ kind: "include", ring: box(0, 0, 20, 20) }, { kind: "include", ring: box(10, 0, 30, 20) }]), 600);
  });

  it("takes away an exclude outline inside the lawn", () => {
    near(lawnSqft([{ kind: "include", ring: box(0, 0, 30, 30) }, { kind: "exclude", ring: box(10, 10, 20, 20) }]), 800);
  });

  it("takes away only the part of an exclude outline that overlaps grass", () => {
    // Half of the 10 x 10 exclusion hangs outside the lawn.
    near(lawnSqft([{ kind: "include", ring: box(0, 0, 30, 30) }, { kind: "exclude", ring: box(25, 10, 35, 20) }]), 850);
    // Entirely outside: nothing is taken.
    near(lawnSqft([{ kind: "include", ring: box(0, 0, 30, 30) }, { kind: "exclude", ring: box(50, 50, 60, 60) }]), 900);
  });

  it("does not take away overlapping exclude outlines twice", () => {
    near(
      lawnSqft([
        { kind: "include", ring: box(0, 0, 30, 30) },
        { kind: "exclude", ring: box(0, 0, 10, 10) },
        { kind: "exclude", ring: box(5, 0, 15, 10) },
      ]),
      750,
    );
  });

  it("is all gone when an exclude outline covers the lawn, and rounds to a whole square foot", () => {
    expect(lawnSqft([{ kind: "include", ring: box(5, 5, 10, 10) }, { kind: "exclude", ring: box(0, 0, 20, 20) }])).toBe(0);
    expect(Number.isInteger(lawnSqft([{ kind: "include", ring: box(0, 0, 13.3, 7.1) }]))).toBe(true);
  });
});

describe("staticImageUrl", () => {
  it("asks for the satellite style at the view, twice the density, with the token", () => {
    expect(staticImageUrl(view, "pk.test")).toBe(
      "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/-77.860000,40.793400,19,0/400x400@2x?access_token=pk.test",
    );
    // The wider picture behind it carries no logo or credit: the one in front does.
    expect(staticImageUrl({ ...view, width: 800, height: 800 }, "pk.test", { bare: true })).toBe(
      "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/-77.860000,40.793400,19,0/800x800@2x?access_token=pk.test&attribution=false&logo=false",
    );
  });
});

describe("geocode", () => {
  const feature = (over: Record<string, unknown> = {}) => ({
    geometry: { coordinates: [HOME.lng, HOME.lat] },
    properties: { feature_type: "address", context: { postcode: { name: "16801" } }, full_address: "200 West College Avenue", ...over },
  });
  const answering = (status: number, body: unknown) => {
    const calls: string[] = [];
    const doFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { calls, doFetch };
  };

  it("asks for one street address in the United States and returns its position, and nothing else of the answer", async () => {
    const { calls, doFetch } = answering(200, { features: [feature()] });
    // R16: only what aims the photo is read; the zip stays the homeowner's own.
    expect(await geocode("200 W College Ave, State College, PA", "pk.test", doFetch)).toEqual({ center: HOME });
    const url = new URL(calls[0]!);
    expect(url.origin + url.pathname).toBe("https://api.mapbox.com/search/geocode/v6/forward");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "200 W College Ave, State College, PA",
      country: "us",
      types: "address",
      limit: "1",
      autocomplete: "false",
      access_token: "pk.test",
    });
  });

  it("is null when nothing matches, the match is not an address, or Mapbox fails", async () => {
    expect(await geocode("x", "pk.test", answering(200, { features: [] }).doFetch)).toBeNull();
    expect(await geocode("x", "pk.test", answering(200, { features: [feature({ feature_type: "place" })] }).doFetch)).toBeNull();
    expect(await geocode("x", "pk.test", answering(200, { features: [{ ...feature(), geometry: { coordinates: ["a", 1] } }] }).doFetch)).toBeNull();
    expect(await geocode("x", "pk.test", answering(401, { message: "Not Authorized" }).doFetch)).toBeNull();
    const failing = (async () => {
      throw new TypeError("network");
    }) as typeof fetch;
    expect(await geocode("x", "pk.test", failing)).toBeNull();
  });
});
