// The aerial photo the homeowner outlines the lawn on. The photo is a static
// image and the outline is an SVG drawn over it, so placing a corner is a
// single tap, click or key press.
//
// The photo is moved with one button in its corner: drag it, or tap it and
// then tap where the centre should be, or focus it and use the arrow keys.
// Dragging is the quick way and never the only one (WCAG 2.5.7).
//
// Corners are kept as places on the ground, not pixels, so the outline stays
// put when the photo is moved or zoomed.

import { useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type Ref } from "react";
import { formatSqft } from "../lib/format";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  project,
  START_ZOOM,
  staticImageUrl,
  totalSqft,
  unproject,
  zoomBy,
  type LngLat,
  type Point,
  type View,
} from "../lib/mapbox";
import { Button, ErrorSummary, errorFor, InlineError, type FieldError } from "./ui";

/** The photo's size in CSS pixels before the stylesheet scales it to the widget's width. */
const SIZE = 400;
/** The contract's bounds for an outlined area, in square feet. */
const MIN_SQFT = 100;
const MAX_SQFT = 2_000_000;

const FIELD = "lq-yard";
/** A press on the move button that travels less than this, in photo pixels, is a tap and not a drag. */
const TAP_SLOP = 4;

/**
 * Behind the photo sits a wider one of the same place, this many times its
 * side, so there is picture beyond every edge to drag into view before the
 * next photo has loaded. The photo in front is the one that carries Mapbox's
 * logo and credit, and at rest it covers the wider one completely.
 */
const WIDE = 2;
/** How far the photo can be dragged before the wider one's edge would show. */
const MARGIN = (SIZE * (WIDE - 1)) / 2;

/** Where a picture is drawn, relative to where it belongs: shifted, and scaled while a zoom loads. */
type Offset = Point & { scale?: number };

/** An offset as a CSS transform. Percentages are of the picture's own size (`side`), so it follows the rendered width. */
const shift = (by: Offset | null, side = SIZE): CSSProperties | undefined =>
  by ? { transform: `translate(${(by.x / side) * 100}%, ${(by.y / side) * 100}%) scale(${by.scale ?? 1})` } : undefined;

const clamp = (value: number) => Math.min(MARGIN, Math.max(-MARGIN, value));

type YardScreenProps = {
  headingRef: Ref<HTMLHeadingElement>;
  address: string;
  token: string;
  center: LngLat;
  /** Outlines from an earlier visit to this screen; the last one is still being drawn. */
  initialRings: LngLat[][];
  busy: boolean;
  alert: ReactNode;
  onChangeAddress(): void;
  /** The homeowner would rather give the lot size, or the photo is no use. */
  onUseLotSize(): void;
  onSubmit(sqft: number, rings: LngLat[][]): void;
};

const closed = (ring: LngLat[]) => ring.length >= 3;

function describe(rings: LngLat[][]): string {
  const areas = rings.filter(closed);
  const open = rings.at(-1)!;
  if (areas.length === 0) {
    if (open.length === 0) return "No corners placed yet.";
    return `${open.length} of at least 3 corners placed.`;
  }
  const sqft = totalSqft(areas);
  const size = sqft < MIN_SQFT ? "less than 100 sq ft" : `about ${formatSqft(Math.round(sqft / 100) * 100)}`;
  const count = areas.length === 1 ? "" : ` in ${areas.length} areas`;
  const pending = !closed(open) && open.length > 0 ? ` The new area has ${open.length} of at least 3 corners.` : "";
  return `Lawn outlined: ${size}${count}.${pending}`;
}

export function YardScreen({ headingRef, ...props }: YardScreenProps) {
  const [view, setView] = useState<View>({ center: props.center, zoom: START_ZOOM, width: SIZE, height: SIZE });
  const [rings, setRings] = useState<LngLat[][]>(props.initialRings.length > 0 ? props.initialRings : [[]]);
  // The keyboard's stand-in for a pointer, shown while the photo has focus.
  const [cursor, setCursor] = useState<Point>({ x: SIZE / 2, y: SIZE / 2 });
  const [focused, setFocused] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const summaryRef = useRef<HTMLDivElement>(null);

  // Moving the photo. `drag`: how far the move button has been dragged so far.
  // `carry`: after the view has moved or zoomed, the old photo stays shifted
  // and scaled into place until the new one has loaded, so the picture does
  // not jump back and forth.
  const [drag, setDrag] = useState<Point | null>(null);
  const [carry, setCarry] = useState<Offset | null>(null);
  // The view whose pixels the wider picture is showing: it lags `view` while its replacement loads.
  const [wideShown, setWideShown] = useState<View | null>(null);
  // After a tap on the move button: the next tap on the photo sets its centre.
  const [recentre, setRecentre] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number; scale: number; moved: boolean } | null>(null);
  const wasDrag = useRef(false);

  const open = rings.at(-1)!;
  const canUndo = rings.length > 1 || open.length > 0;
  const canStartAnother = closed(open);

  function addCorner(point: Point) {
    const at = unproject(point, view);
    setRings((current) => [...current.slice(0, -1), [...current.at(-1)!, at]]);
    setErrors((current) => current.filter((e) => e.field !== FIELD));
  }

  function undo() {
    setRings((current) => {
      const last = current.at(-1)!;
      if (last.length > 0) return [...current.slice(0, -1), last.slice(0, -1)];
      // The area just started is empty: go back to the one before it.
      return current.length > 1 ? current.slice(0, -1) : current;
    });
  }

  /** Moves the view so the place now at `point` on the photo is at its centre. */
  function centreOn(point: Point) {
    setView((v) => ({ ...v, center: unproject(point, v) }));
    setCarry({ x: SIZE / 2 - point.x, y: SIZE / 2 - point.y });
  }

  /** Zooms in or out a level, stretching the photo on screen to the new scale until the sharper one arrives. */
  function zoom(steps: number) {
    const next = zoomBy(view, steps);
    if (next.zoom === view.zoom) return;
    setView(next);
    setCarry({ x: 0, y: 0, scale: 2 ** (next.zoom - view.zoom) });
  }

  function onClick(event: MouseEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const scale = SIZE / box.width;
    const point = { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
    if (recentre) {
      setRecentre(false);
      centreOn(point);
      return;
    }
    setCursor(point);
    addCorner(point);
  }

  // ---- the move button

  function onMoveDown(event: PointerEvent<HTMLButtonElement>) {
    const width = mapRef.current?.getBoundingClientRect().width ?? 0;
    if (width === 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    // A new press: whatever the last one was, this one is not yet a drag.
    wasDrag.current = false;
    press.current = { x: event.clientX, y: event.clientY, scale: SIZE / width, moved: false };
  }

  function onMoveDrag(event: PointerEvent<HTMLButtonElement>) {
    const start = press.current;
    if (!start) return;
    // No further than there is picture to show.
    const by = { x: clamp((event.clientX - start.x) * start.scale), y: clamp((event.clientY - start.y) * start.scale) };
    if (!start.moved && Math.hypot(by.x, by.y) < TAP_SLOP) return;
    start.moved = true;
    setDrag(by);
  }

  // Ends a press on the move button. Called on release and again when the
  // browser takes the pointer capture away, which can happen without a
  // release reaching the button; the second call finds nothing to do.
  function onMoveUp() {
    const start = press.current;
    press.current = null;
    if (!start?.moved || !drag) return;
    // The click that follows this release is the end of a drag, not a tap.
    wasDrag.current = true;
    setRecentre(false);
    // The photo was pulled by `drag`, so what was that far the other way is now at the centre.
    centreOn({ x: SIZE / 2 - drag.x, y: SIZE / 2 - drag.y });
    setDrag(null);
  }

  function onMoveClick() {
    if (wasDrag.current) {
      wasDrag.current = false;
      return;
    }
    setRecentre((on) => !on);
  }

  function onMoveKey(event: KeyboardEvent<HTMLButtonElement>) {
    const by: Record<string, [number, number]> = { ArrowLeft: [-0.25, 0], ArrowRight: [0.25, 0], ArrowUp: [0, -0.25], ArrowDown: [0, 0.25] };
    const step = by[event.key];
    if (!step) return;
    // Otherwise the arrow keys would scroll the page.
    event.preventDefault();
    setRecentre(false);
    centreOn({ x: SIZE * (0.5 + step[0]), y: SIZE * (0.5 + step[1]) });
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const step = event.shiftKey ? 2 : 10;
    const move = (dx: number, dy: number) =>
      setCursor((c) => ({ x: Math.min(SIZE, Math.max(0, c.x + dx)), y: Math.min(SIZE, Math.max(0, c.y + dy)) }));
    switch (event.key) {
      case "ArrowLeft":
        move(-step, 0);
        break;
      case "ArrowRight":
        move(step, 0);
        break;
      case "ArrowUp":
        move(0, -step);
        break;
      case "ArrowDown":
        move(0, step);
        break;
      case "Enter":
      case " ":
        addCorner(cursor);
        break;
      case "Backspace":
      case "Delete":
        undo();
        break;
      default:
        return;
    }
    // These keys would otherwise scroll the page or submit the form.
    event.preventDefault();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (props.busy) return;
    const areas = rings.filter(closed);
    const sqft = totalSqft(areas);
    const found: FieldError[] = [];
    if (areas.length === 0) found.push({ field: FIELD, message: "Outline the lawn by placing at least 3 corners on the photo." });
    else if (sqft < MIN_SQFT) found.push({ field: FIELD, message: "That outline is under 100 square feet. Outline the whole lawn." });
    else if (sqft > MAX_SQFT) found.push({ field: FIELD, message: "That outline is over 2,000,000 square feet. Outline only the lawn." });
    setErrors(found);
    if (found.length > 0) {
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    props.onSubmit(sqft, areas);
  }

  const error = errorFor(errors, FIELD);

  // The wider picture is placed by where its own centre falls in the current
  // view, so it is right whichever view it was fetched for, and follows a drag.
  const wideOffset: Offset | null = wideShown && {
    x: project(wideShown.center, view).x - SIZE / 2 + (drag?.x ?? 0),
    y: project(wideShown.center, view).y - SIZE / 2 + (drag?.y ?? 0),
    scale: 2 ** (view.zoom - wideShown.zoom),
  };

  return (
    <form onSubmit={submit} noValidate>
      <h1 ref={headingRef} tabIndex={-1} className="lq-h1">
        Outline your lawn
      </h1>
      <p className="lq-lead">
        Mark each corner of the grass on the aerial photo, leaving out the house, driveway and anything that isn&apos;t mowed.
      </p>
      <p className="lq-address">
        <span>
          <span className="lq-sr">Property address: </span>
          {props.address}
        </span>
        <Button variant="link" onClick={props.onChangeAddress}>
          Change address
        </Button>
      </p>
      <ErrorSummary errors={errors} summaryRef={summaryRef} />

      <div className="lq-field">
        <p id={`${FIELD}-label`} className="lq-label">
          Lawn outline
        </p>
        <p id={`${FIELD}-hint`} className="lq-hint">
          Tap or click each corner in turn. With a keyboard, the arrow keys move the crosshair, Enter places a corner and Backspace
          removes the last one. For a front and a back yard, outline one, choose Start another area, then outline the other.
        </p>
        <p id={`${FIELD}-move-hint`} className="lq-hint">
          To see more, drag the move button in the photo&apos;s corner. Or tap it, then tap where the centre should be; or focus it and use
          the arrow keys.
        </p>
        <div className="lq-map" ref={mapRef}>
          {/* Decorative here: the address above says what it shows, and the outline control carries the name. */}
          <img
            className="lq-map-wide"
            src={staticImageUrl({ ...view, width: SIZE * WIDE, height: SIZE * WIDE }, props.token, { bare: true })}
            alt=""
            width={SIZE * WIDE}
            height={SIZE * WIDE}
            draggable={false}
            style={shift(wideOffset, SIZE * WIDE)}
            onLoad={() => setWideShown(view)}
          />
          <img
            className="lq-map-photo"
            src={staticImageUrl(view, props.token)}
            alt=""
            width={SIZE}
            height={SIZE}
            draggable={false}
            style={shift(drag ?? carry)}
            onLoad={() => {
              setPhotoFailed(false);
              setCarry(null);
            }}
            onError={() => {
              setPhotoFailed(true);
              setCarry(null);
            }}
          />
          <svg
            id={FIELD}
            className="lq-map-outline"
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            role="application"
            tabIndex={0}
            aria-labelledby={`${FIELD}-label`}
            aria-describedby={[`${FIELD}-hint`, `${FIELD}-status`, error ? `${FIELD}-error` : null].filter(Boolean).join(" ")}
            aria-invalid={error ? true : undefined}
            onClick={onClick}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          >
            {/* The outline rides along with the photo while it is being dragged. */}
            <g transform={drag ? `translate(${drag.x.toFixed(1)},${drag.y.toFixed(1)})` : undefined}>
            {rings.map((ring, index) => {
              const points = ring.map((corner) => project(corner, view));
              const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
              return (
                <g key={index}>
                  {closed(ring) ? (
                    <>
                      <polygon className="lq-map-halo" points={path} />
                      <polygon className="lq-map-area" points={path} />
                    </>
                  ) : (
                    <>
                      <polyline className="lq-map-halo" points={path} />
                      <polyline className="lq-map-line" points={path} />
                    </>
                  )}
                  {points.map((p, corner) => (
                    <circle key={corner} className="lq-map-corner" cx={p.x} cy={p.y} r={5} />
                  ))}
                </g>
              );
            })}
            </g>
            {focused && (
              <g className="lq-map-cursor" aria-hidden="true">
                <path className="lq-map-halo" d={`M${cursor.x - 12},${cursor.y}h24M${cursor.x},${cursor.y - 12}v24`} />
                <path className="lq-map-line" d={`M${cursor.x - 12},${cursor.y}h24M${cursor.x},${cursor.y - 12}v24`} />
              </g>
            )}
          </svg>
          <div className="lq-map-zoom" role="group" aria-label="Zoom">
            <MapButton label="Zoom in" disabled={view.zoom >= MAX_ZOOM} onClick={() => zoom(1)}>
              +
            </MapButton>
            <MapButton label="Zoom out" disabled={view.zoom <= MIN_ZOOM} onClick={() => zoom(-1)}>
              &minus;
            </MapButton>
          </div>
          <button
            type="button"
            className="lq-map-btn lq-map-move"
            aria-label="Move the photo"
            aria-describedby={`${FIELD}-move-hint`}
            aria-pressed={recentre}
            onPointerDown={onMoveDown}
            onPointerMove={onMoveDrag}
            onPointerUp={onMoveUp}
            onLostPointerCapture={onMoveUp}
            onPointerCancel={() => {
              press.current = null;
              setDrag(null);
            }}
            onClick={onMoveClick}
            onKeyDown={onMoveKey}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M12 2l3.5 3.5h-2.5V11h5.5V8.500L22 12l-3.5 3.5V13H13v5.500h2.500L12 22l-3.500-3.500H11V13H5.500v2.500L2 12l3.500-3.500V11H11V5.500H8.500z" />
            </svg>
          </button>
        </div>
        {photoFailed && (
          <p className="lq-alert" role="alert">
            The aerial photo didn&apos;t load. Try again in a moment, or enter the lot size instead.
          </p>
        )}
        <p id={`${FIELD}-status`} className="lq-map-status" role="status">
          {recentre ? "Tap the photo where its centre should be." : describe(rings)}
        </p>
        <InlineError id={FIELD} message={error} />

        <div className="lq-map-tools" role="group" aria-label="Outline">
          <ToolButton disabled={!canUndo} onClick={undo}>
            Undo corner
          </ToolButton>
          <ToolButton disabled={!canStartAnother} onClick={() => setRings((current) => [...current, []])}>
            Start another area
          </ToolButton>
          <ToolButton disabled={!canUndo} onClick={() => setRings([[]])}>
            Clear
          </ToolButton>
        </div>
        <p className="lq-credit">Aerial imagery © Mapbox © OpenStreetMap © Maxar. It can be a few years old.</p>
      </div>

      {props.alert}
      <div className="lq-actions">
        <Button type="submit" busy={props.busy} busyLabel="Getting your estimate…">
          Get my estimate
        </Button>
        <Button variant="secondary" onClick={props.onUseLotSize}>
          Enter the lot size instead
        </Button>
      </div>
    </form>
  );
}

/** A small button drawn over the photo. Stays focusable when it has nothing to do, like the widget's other buttons. */
function MapButton({ children, label, disabled = false, onClick }: { children: ReactNode; label: string; disabled?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className="lq-map-btn"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {children}
    </button>
  );
}

/** Stays focusable when it has nothing to do (aria-disabled), like the widget's other buttons. */
function ToolButton({ children, label, disabled = false, onClick }: { children: ReactNode; label?: string; disabled?: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      className="lq-chip"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {children}
    </button>
  );
}
