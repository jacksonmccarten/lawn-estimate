// Mapbox, as the widget uses it: one geocoding call to find the address, and
// static satellite images the homeowner outlines the lawn on. No map library:
// the photo is an <img>, the outline is our own SVG, and the arithmetic that
// ties a point on the photo to a point on the ground is below.
//
// The token is a Mapbox public token (pk.), which is made to be sent to
// browsers; it is restricted to our origins in the Mapbox account.

import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";

export type LngLat = { lng: number; lat: number };

/** A static image: what is at its center, how far in, and its size in CSS pixels. */
export type View = { center: LngLat; zoom: number; width: number; height: number };

export type Point = { x: number; y: number };

export type Place = { center: LngLat };

const API = "https://api.mapbox.com";

/** Mapbox draws static images on 512-pixel tiles: the world is this many pixels wide at a zoom. */
const worldSize = (zoom: number) => 512 * 2 ** zoom;

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6_378_137;
const SQFT_PER_SQM = 10.763_910_4;

export const MIN_ZOOM = 16;
export const MAX_ZOOM = 20;
/** About 90 m across at Pennsylvania's latitude in a 400-pixel photo: a suburban lot and its neighbours, since the address point is often at the street. */
export const START_ZOOM = 18;

// ---- Web Mercator

function toWorld({ lng, lat }: LngLat, zoom: number): Point {
  const size = worldSize(zoom);
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

function fromWorld({ x, y }: Point, zoom: number): LngLat {
  const size = worldSize(zoom);
  const n = Math.PI * (1 - (2 * y) / size);
  return { lng: (x / size) * 360 - 180, lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI };
}

/** Where a place on the ground falls on the photo, in CSS pixels from its top left. */
export function project(at: LngLat, view: View): Point {
  const center = toWorld(view.center, view.zoom);
  const world = toWorld(at, view.zoom);
  return { x: world.x - center.x + view.width / 2, y: world.y - center.y + view.height / 2 };
}

/** The place on the ground under a point of the photo. */
export function unproject(point: Point, view: View): LngLat {
  const center = toWorld(view.center, view.zoom);
  return fromWorld({ x: center.x + point.x - view.width / 2, y: center.y + point.y - view.height / 2 }, view.zoom);
}

/** The view moved by a fraction of its own size: (1, 0) is one photo to the right. */
export function pan(view: View, dx: number, dy: number): View {
  return { ...view, center: unproject({ x: view.width * (0.5 + dx), y: view.height * (0.5 + dy) }, view) };
}

export function zoomBy(view: View, steps: number): View {
  return { ...view, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom + steps)) };
}

// ---- Area

/**
 * The area of one outline in square feet. The corners are laid out in metres
 * around the outline's own latitude, which is exact enough at the size of a
 * yard: the error over a two-acre lot is far below the 100 sq ft the price
 * is rounded to.
 */
export function ringSqft(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const zoom = 20;
  const meanLat = ring.reduce((sum, p) => sum + p.lat, 0) / ring.length;
  const metresPerPixel = (EARTH_CIRCUMFERENCE_M * Math.cos((meanLat * Math.PI) / 180)) / worldSize(zoom);
  const points = ring.map((p) => toWorld(p, zoom));
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return (Math.abs(twice) / 2) * metresPerPixel ** 2 * SQFT_PER_SQM;
}

/** Every outline with at least three corners, added up and rounded to a whole square foot. */
export function totalSqft(rings: LngLat[][]): number {
  return Math.round(rings.reduce((sum, ring) => sum + ringSqft(ring), 0));
}

/** An outline the homeowner drew: grass to mow (`include`), or something inside it to leave out (`exclude`). */
export type Shape = { kind: "include" | "exclude"; ring: LngLat[] };

function shoelace(ring: [number, number][]): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % ring.length]!;
    twice += ax * by - bx * ay;
  }
  return Math.abs(twice) / 2;
}

/**
 * The lawn: every include outline joined together, less whatever of the
 * exclude outlines falls inside it, in square feet rounded to a whole one.
 * Overlapping include outlines count once, and an exclude outline only takes
 * away the part that overlaps grass. Laid out in metres around the shapes'
 * own latitude, as in `ringSqft`.
 */
export function lawnSqft(shapes: Shape[]): number {
  const drawn = shapes.filter((s) => s.ring.length >= 3);
  const includes = drawn.filter((s) => s.kind === "include");
  if (includes.length === 0) return 0;
  const zoom = 20;
  const all = drawn.flatMap((s) => s.ring);
  const meanLat = all.reduce((sum, p) => sum + p.lat, 0) / all.length;
  const metresPerPixel = (EARTH_CIRCUMFERENCE_M * Math.cos((meanLat * Math.PI) / 180)) / worldSize(zoom);
  const toPolygon = (ring: LngLat[]): Polygon => [
    ring.map((p) => {
      const w = toWorld(p, zoom);
      return [w.x, w.y] as [number, number];
    }),
  ];
  const [first, ...rest] = includes.map((s) => toPolygon(s.ring));
  let lawn: MultiPolygon = polygonClipping.union(first!, ...rest);
  const excludes = drawn.filter((s) => s.kind === "exclude").map((s) => toPolygon(s.ring));
  if (excludes.length > 0) lawn = polygonClipping.difference(lawn, ...excludes);
  const pixels = lawn.reduce(
    (sum, [outer, ...holes]) => sum + shoelace(outer!) - holes.reduce((h, hole) => h + shoelace(hole), 0),
    0,
  );
  return Math.round(pixels * metresPerPixel ** 2 * SQFT_PER_SQM);
}

// ---- The two calls

/**
 * The satellite photo of a view, at twice the pixel density. Mapbox's logo
 * and attribution are drawn on it. `bare` leaves them off, for a picture
 * that is only ever seen behind one that carries them.
 */
export function staticImageUrl(view: View, token: string, options: { bare?: boolean } = {}): string {
  const { center, zoom, width, height } = view;
  const at = `${center.lng.toFixed(6)},${center.lat.toFixed(6)},${zoom},0`;
  const bare = options.bare ? "&attribution=false&logo=false" : "";
  return `${API}/styles/v1/mapbox/satellite-v9/static/${at}/${width}x${height}@2x?access_token=${encodeURIComponent(token)}${bare}`;
}

type GeocodeFeature = {
  geometry?: { coordinates?: unknown };
  properties?: { feature_type?: unknown };
};

/**
 * The first street-address match for what the homeowner typed, in the United
 * States. Null when there is none, the answer is not an address, or Mapbox
 * cannot be reached: the homeowner gives the lot size instead. Only the
 * position is read, to aim the photo; nothing of the answer is sent to our
 * API or stored (R16), which is why the zip is the homeowner's own.
 */
export async function geocode(address: string, token: string, doFetch: typeof fetch = fetch): Promise<Place | null> {
  const query = new URLSearchParams({ q: address, country: "us", types: "address", limit: "1", autocomplete: "false", access_token: token });
  try {
    const response = await doFetch(`${API}/search/geocode/v6/forward?${query}`, { credentials: "omit", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { features?: GeocodeFeature[] };
    const feature = body.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (!feature || feature.properties?.feature_type !== "address" || !Array.isArray(coordinates)) return null;
    const [lng, lat] = coordinates as unknown[];
    if (typeof lng !== "number" || typeof lat !== "number" || Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;
    return { center: { lng, lat } };
  } catch {
    return null;
  }
}
