// The aerial photo the homeowner outlines the lawn on. The photo is a static
// image and the outlines are an SVG drawn over it, so placing a corner is a
// single tap, click or key press.
//
// Two kinds of outline: positive areas are grass to mow, negative areas are
// what to leave out of it (the house, a pool). The lawn is the positive areas
// joined, less the parts of the negative ones that overlap them (`lawnSqft`).
// A finished outline can be selected, its corners moved, or deleted, and
// every change can be undone.
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
  lawnSqft,
  MAX_ZOOM,
  MIN_ZOOM,
  project,
  START_ZOOM,
  staticImageUrl,
  unproject,
  zoomBy,
  type LngLat,
  type Point,
  type Shape,
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
/** A tap or the crosshair this close to a corner, in photo pixels, is on that corner. */
const CORNER_REACH = 14;

/**
 * Where a short looping animation of the drawing tools will go, served from
 * the widget's own origin (the CSP allows no other). Null until it is made:
 * the steps are listed in its place.
 */
const HOW_TO_GIF: string | null = null;

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
  /** Outlines from an earlier visit to this screen. */
  initialShapes: Shape[];
  busy: boolean;
  alert: ReactNode;
  onChangeAddress(): void;
  /** The photo is no use: the homeowner gives the lot size instead. */
  onUseLotSize(): void;
  onSubmit(sqft: number, shapes: Shape[]): void;
};

type Kind = Shape["kind"];

/**
 * Everything undo can put back: the finished outlines, and the one being
 * drawn (null when none is: a tap then selects an outline).
 */
type Drawing = { shapes: Shape[]; draft: Shape | null };

const KIND_NAME: Record<Kind, string> = { include: "positive area", exclude: "negative area" };

const closed = (ring: LngLat[]) => ring.length >= 3;

/** The drawing with its unfinished outline closed, when it has enough corners, or dropped. */
function finished({ shapes, draft }: Drawing): Shape[] {
  return draft && closed(draft.ring) ? [...shapes, draft] : shapes;
}

function insidePolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function describe(drawing: Drawing, selected: number | null, grabbed: boolean): string {
  const { shapes, draft } = drawing;
  const sqft = lawnSqft(finished(drawing));
  const size =
    shapes.length === 0 && !(draft && closed(draft.ring))
      ? "nothing outlined yet"
      : sqft < MIN_SQFT
        ? "less than 100 sq ft"
        : `about ${formatSqft(Math.round(sqft / 100) * 100)}`;
  const parts = [`Lawn area: ${size}.`];
  if (draft) {
    const placed = draft.ring.length;
    parts.push(
      placed === 0
        ? `Drawing a ${KIND_NAME[draft.kind]}: place its first corner.`
        : `Drawing a ${KIND_NAME[draft.kind]}: ${placed} ${placed === 1 ? "corner" : "corners"} placed${placed < 3 ? `, at least 3 needed` : ""}.`,
    );
  } else if (selected !== null && shapes[selected]) {
    parts.push(grabbed ? "Corner picked up: move it, then press Enter to put it down." : `${capital(KIND_NAME[shapes[selected].kind])} selected.`);
  }
  return parts.join(" ");
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function YardScreen({ headingRef, ...props }: YardScreenProps) {
  const [view, setView] = useState<View>({ center: props.center, zoom: START_ZOOM, width: SIZE, height: SIZE });
  const [drawing, setDrawing] = useState<Drawing>(() =>
    props.initialShapes.length > 0 ? { shapes: props.initialShapes, draft: null } : { shapes: [], draft: { kind: "include", ring: [] } },
  );
  // Earlier drawings, newest last, for undo.
  const [history, setHistory] = useState<Drawing[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  // A corner of the selected outline being moved: by a pointer drag, or picked up with the keyboard.
  const [grab, setGrab] = useState<{ corner: number; by: "pointer" | "keyboard" } | null>(null);
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

  const { shapes, draft } = drawing;
  const canUndo = history.length > 0;
  const canFinish = draft !== null && closed(draft.ring);

  /** Makes a change that undo can take back. */
  function commit(next: Drawing) {
    setHistory((h) => [...h, drawing]);
    setDrawing(next);
    setErrors((current) => current.filter((e) => e.field !== FIELD));
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    setDrawing(previous);
    setGrab(null);
    if (selected !== null && selected >= previous.shapes.length) setSelected(null);
  }

  /** Starts a new outline of a kind, finishing the one being drawn if it has enough corners. */
  function startShape(kind: Kind) {
    if (draft && draft.ring.length === 0) {
      if (draft.kind !== kind) setDrawing({ shapes, draft: { kind, ring: [] } });
    } else {
      commit({ shapes: finished(drawing), draft: { kind, ring: [] } });
    }
    setSelected(null);
    setGrab(null);
  }

  function finishShape() {
    if (!draft || !closed(draft.ring)) return;
    commit({ shapes: [...shapes, draft], draft: null });
    setSelected(shapes.length);
  }

  function addCorner(point: Point) {
    if (!draft) return;
    // A tap on the first corner closes the outline.
    const first = draft.ring[0];
    if (closed(draft.ring) && first) {
      const p = project(first, view);
      if (Math.hypot(p.x - point.x, p.y - point.y) <= CORNER_REACH) return finishShape();
    }
    commit({ shapes, draft: { ...draft, ring: [...draft.ring, unproject(point, view)] } });
  }

  /** The outline under a point of the photo, the most recently drawn first. */
  function shapeAt(point: Point): number | null {
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (insidePolygon(point, shapes[i]!.ring.map((c) => project(c, view)))) return i;
    }
    return null;
  }

  /** The corner of the selected outline at a point of the photo. */
  function cornerAt(point: Point): number | null {
    if (selected === null) return null;
    const ring = shapes[selected]?.ring ?? [];
    let best: number | null = null;
    let bestDistance = CORNER_REACH;
    ring.forEach((c, i) => {
      const p = project(c, view);
      const distance = Math.hypot(p.x - point.x, p.y - point.y);
      if (distance <= bestDistance) {
        best = i;
        bestDistance = distance;
      }
    });
    return best;
  }

  /** Moves a corner of the selected outline without a new undo step: the step was taken when it was picked up. */
  function moveCorner(corner: number, point: Point) {
    if (selected === null) return;
    const at = unproject({ x: Math.min(SIZE, Math.max(0, point.x)), y: Math.min(SIZE, Math.max(0, point.y)) }, view);
    setDrawing((d) => ({
      ...d,
      shapes: d.shapes.map((shape, i) => (i === selected ? { ...shape, ring: shape.ring.map((c, j) => (j === corner ? at : c)) } : shape)),
    }));
  }

  function pickUp(corner: number, by: "pointer" | "keyboard") {
    setHistory((h) => [...h, drawing]);
    setGrab({ corner, by });
  }

  function deleteSelected() {
    if (selected === null) return;
    commit({ shapes: shapes.filter((_, i) => i !== selected), draft });
    setSelected(null);
    setGrab(null);
  }

  /** A tap, click or Enter at a point of the photo. */
  function act(point: Point) {
    if (draft) return addCorner(point);
    setSelected(shapeAt(point));
  }

  /** A point of the photo under a pointer, in photo pixels. */
  function photoPoint(event: { clientX: number; clientY: number }, svg: SVGSVGElement | null): Point | null {
    const box = svg?.getBoundingClientRect();
    if (!box || box.width === 0) return null;
    const scale = SIZE / box.width;
    return { x: (event.clientX - box.left) * scale, y: (event.clientY - box.top) * scale };
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
    const point = photoPoint(event, event.currentTarget);
    if (!point) return;
    if (recentre) {
      setRecentre(false);
      centreOn(point);
      return;
    }
    setCursor(point);
    act(point);
  }

  // ---- dragging a corner of the selected outline

  function onCornerDown(event: PointerEvent<SVGCircleElement>, corner: number) {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pickUp(corner, "pointer");
  }

  function onCornerMove(event: PointerEvent<SVGCircleElement>) {
    if (grab?.by !== "pointer") return;
    const point = photoPoint(event, event.currentTarget.ownerSVGElement);
    if (point) moveCorner(grab.corner, point);
  }

  function onCornerUp() {
    if (grab?.by === "pointer") setGrab(null);
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
    const move = (dx: number, dy: number) => {
      const next = { x: Math.min(SIZE, Math.max(0, cursor.x + dx)), y: Math.min(SIZE, Math.max(0, cursor.y + dy)) };
      setCursor(next);
      // A corner picked up with the keyboard goes where the crosshair goes.
      if (grab?.by === "keyboard") moveCorner(grab.corner, next);
    };
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
      case " ": {
        if (grab) {
          setGrab(null);
          break;
        }
        const corner = draft ? null : cornerAt(cursor);
        if (corner !== null) pickUp(corner, "keyboard");
        else act(cursor);
        break;
      }
      case "Escape":
        if (grab) undo();
        else if (selected !== null) setSelected(null);
        else return;
        break;
      case "Backspace":
      case "Delete":
        if (!draft && selected !== null) deleteSelected();
        else undo();
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
    const areas = finished(drawing);
    const sqft = lawnSqft(areas);
    const found: FieldError[] = [];
    if (!areas.some((a) => a.kind === "include"))
      found.push({ field: FIELD, message: "Outline the lawn with Add positive area, placing at least 3 corners on the photo." });
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
    <form onSubmit={submit} noValidate className="lq-yard">
      <div className="lq-yard-intro">
        <h1 ref={headingRef} tabIndex={-1} className="lq-h1">
          Draw Your Lawn
        </h1>
        <p className="lq-lead">
          Outline the grass you want mowed using Add Positive Area. Use Add Negative Area to exclude your house, driveway, pool, or other
          areas that shouldn&apos;t be included.
        </p>
        <figure className="lq-howto">
          {HOW_TO_GIF ? (
            <img src={HOW_TO_GIF} alt="An outline drawn around a lawn, then the house outlined and taken away from it." width={320} height={240} />
          ) : (
            <ol className="lq-howto-steps">
              <li>Choose Add Positive Area and tap each corner of the grass.</li>
              <li>Tap the first corner again, or choose Finish area, to close it.</li>
              <li>Choose Add Negative Area to cut out the house, driveway or pool.</li>
              <li>Tap an outline to select it, then drag its corners to adjust.</li>
            </ol>
          )}
        </figure>
      </div>

      <div className="lq-yard-map">
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
            Tap or click each corner in turn. With a keyboard, the arrow keys move the crosshair and Enter places a corner. To change a
            finished outline, select it with Enter, put the crosshair on a corner, press Enter to pick it up, move it, and press Enter again.
            Delete removes the selected outline.
          </p>
          <p id={`${FIELD}-move-hint`} className="lq-hint">
            To see more, drag the move button in the photo&apos;s corner. Or tap it, then tap where the centre should be; or focus it and use
            the arrow keys.
          </p>

          <div className="lq-map-tools" role="group" aria-label="Drawing tools">
            <ToolButton pressed={draft?.kind === "include"} onClick={() => startShape("include")}>
              <span aria-hidden="true">+ </span>Add Positive Area
            </ToolButton>
            <ToolButton pressed={draft?.kind === "exclude"} onClick={() => startShape("exclude")}>
              <span aria-hidden="true">&minus; </span>Add Negative Area
            </ToolButton>
            <ToolButton disabled={!canUndo} onClick={undo}>
              <span aria-hidden="true">&#8630; </span>Undo
            </ToolButton>
          </div>

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
              {/* The outlines ride along with the photo while it is being dragged. */}
              <g transform={drag ? `translate(${drag.x.toFixed(1)},${drag.y.toFixed(1)})` : undefined}>
                {shapes.map((shape, index) => {
                  const points = shape.ring.map((corner) => project(corner, view));
                  const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
                  const isSelected = index === selected && !draft;
                  return (
                    <g key={index} className={`lq-map-shape lq-map-${shape.kind}${isSelected ? " lq-map-selected" : ""}`}>
                      <polygon className="lq-map-halo" points={path} />
                      <polygon className="lq-map-area" points={path} />
                      {isSelected &&
                        points.map((p, corner) => (
                          <circle
                            key={corner}
                            className="lq-map-handle"
                            cx={p.x}
                            cy={p.y}
                            r={8}
                            onPointerDown={(event) => onCornerDown(event, corner)}
                            onPointerMove={onCornerMove}
                            onPointerUp={onCornerUp}
                            onLostPointerCapture={onCornerUp}
                            onClick={(event) => event.stopPropagation()}
                          />
                        ))}
                    </g>
                  );
                })}
                {draft && draft.ring.length > 0 && (
                  <g className={`lq-map-shape lq-map-${draft.kind}`}>
                    {(() => {
                      const points = draft.ring.map((corner) => project(corner, view));
                      const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
                      return (
                        <>
                          <polyline className="lq-map-halo" points={path} />
                          <polyline className="lq-map-line" points={path} />
                          {points.map((p, corner) => (
                            <circle key={corner} className="lq-map-corner" cx={p.x} cy={p.y} r={corner === 0 && closed(draft.ring) ? 7 : 5} />
                          ))}
                        </>
                      );
                    })()}
                  </g>
                )}
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
            {recentre ? "Tap the photo where its centre should be." : describe(drawing, selected, grab !== null)}
          </p>
          <InlineError id={FIELD} message={error} />

          <div className="lq-map-tools" role="group" aria-label="Outline">
            <ToolButton disabled={!canFinish} onClick={finishShape}>
              Finish area
            </ToolButton>
            <ToolButton disabled={selected === null || draft !== null} onClick={deleteSelected}>
              Delete selected area
            </ToolButton>
            <ToolButton
              disabled={shapes.length === 0 && (draft?.ring.length ?? 0) === 0}
              onClick={() => {
                commit({ shapes: [], draft: { kind: "include", ring: [] } });
                setSelected(null);
                setGrab(null);
              }}
            >
              Clear all
            </ToolButton>
          </div>
          <p className="lq-credit">Aerial imagery © Mapbox © OpenStreetMap © Maxar. It can be a few years old.</p>
        </div>

        {props.alert}
        <div className="lq-actions">
          <Button type="submit" busy={props.busy} busyLabel="Getting your estimate…">
            Get my estimate
          </Button>
          {/* Only when the photo is no use: otherwise the lawn area always comes from the outlines. */}
          {photoFailed && (
            <Button variant="secondary" onClick={props.onUseLotSize}>
              Enter the lot size instead
            </Button>
          )}
        </div>
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
function ToolButton({
  children,
  label,
  disabled = false,
  pressed,
  onClick,
}: {
  children: ReactNode;
  label?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="lq-chip"
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {children}
    </button>
  );
}
