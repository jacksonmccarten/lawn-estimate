"use client";

import { Origin, Theme, type Company } from "@lq/api-contract";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "react-aria-components";
import { useApi } from "@/components/auth-provider";
import { BusyButton, errorFor, ErrorSummary, LoadError, Loading, PageHeading, TextInput, useToast } from "@/components/ui";
import { describeError } from "@/lib/api";
import { brandColorUse } from "@/lib/contrast";
import type { FieldError } from "@/lib/pricing-form";
import { qrModules, qrPath, qrSide, QUIET_ZONE } from "@/lib/qr";
import { useLoad } from "@/lib/use-load";

const MAX_ORIGINS = 20;
const SCRIPT_ORIGIN = process.env.NEXT_PUBLIC_WIDGET_SCRIPT_ORIGIN ?? "";
const APP_ORIGIN = process.env.NEXT_PUBLIC_WIDGET_APP_ORIGIN ?? "";

/** "https://www.example.com/quote" → "https://www.example.com". Null when it is not a web address. */
function toOrigin(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return Origin.safeParse(url.origin).success ? url.origin : null;
  } catch {
    return null;
  }
}

function CopyBlock({ label, value, id }: { label: string; value: string; id: string }) {
  const [status, setStatus] = useState("");
  return (
    <div className="copy-block">
      <h3 id={`${id}-label`}>{label}</h3>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a long line scrolls sideways; it must be reachable to scroll by keyboard */}
      <pre tabIndex={0} aria-labelledby={`${id}-label`}>
        <code>{value}</code>
      </pre>
      <Button
        className="btn"
        aria-label={`Copy ${label.toLowerCase()}`}
        onPress={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus("Copied.");
          } catch {
            setStatus("Couldn’t copy automatically. Select the text and copy it.");
          }
        }}
      >
        Copy
      </Button>
      <span role="status" className="muted copy-status">
        {status}
      </span>
    </div>
  );
}

/** The side, in pixels, of the picture that is downloaded: large enough to print on a sign. */
const QR_PRINT_PIXELS = 1200;

/**
 * The hosted page link as a QR code, to print on a truck, a sign or a flyer.
 * Always black on white, whatever the color scheme: that is what scanners
 * expect, and the two are not theme colors.
 */
function QrBlock({ url, slug }: { url: string; slug: string }) {
  const modules = useMemo(() => qrModules(url), [url]);
  const side = qrSide(modules);
  const [status, setStatus] = useState("");

  function download() {
    // Whole pixels for each module, so the edges stay sharp when it is printed.
    const scale = Math.max(1, Math.floor(QR_PRINT_PIXELS / side));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side * scale;
    const context = canvas.getContext("2d");
    if (!context) return setStatus("Couldn’t make the picture in this browser.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#000000";
    modules.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) context.fillRect((x + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, scale, scale);
      }),
    );
    canvas.toBlob((blob) => {
      if (!blob) return setStatus("Couldn’t make the picture in this browser.");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${slug}-quote-qr.png`;
      link.click();
      URL.revokeObjectURL(link.href);
      setStatus("Downloaded.");
    }, "image/png");
  }

  return (
    <div className="copy-block qr-block">
      <h3 id="qr-label">QR code for the hosted page</h3>
      <p className="muted">Print it on a truck, a yard sign or a flyer. Scanning it opens your quote page.</p>
      <svg className="qr" role="img" aria-label={`QR code that opens ${url}`} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges">
        <rect width={side} height={side} fill="#ffffff" />
        <path d={qrPath(modules)} fill="#000000" />
      </svg>
      <Button className="btn" onPress={download}>
        Download QR code
      </Button>
      <span role="status" className="muted copy-status">
        {status}
      </span>
    </div>
  );
}

function Settings({ company, onSaved }: { company: Company; onSaved: (company: Company) => void }) {
  const api = useApi();
  const toast = useToast();
  const [name, setName] = useState(company.name);
  const [hicNo, setHicNo] = useState(company.hicNo ?? "");
  const [color, setColor] = useState(company.theme.color ?? "");
  const [origins, setOrigins] = useState(company.allowedOrigins);
  const [newOrigin, setNewOrigin] = useState("");
  const [originError, setOriginError] = useState<string | undefined>();
  const [originStatus, setOriginStatus] = useState("");
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const focusSummary = useRef(false);
  const originInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSummary.current) {
      focusSummary.current = false;
      summaryRef.current?.focus();
    }
  }, [errors]);

  function addOrigin() {
    const origin = toOrigin(newOrigin);
    if (!origin) return setOriginError("Enter a website address, such as https://www.example.com");
    if (origins.some((o) => o.toLowerCase() === origin.toLowerCase())) return setOriginError(`${origin} is already on the list`);
    if (origins.length >= MAX_ORIGINS) return setOriginError(`The list can hold ${MAX_ORIGINS} sites at most`);
    setOrigins([...origins, origin]);
    setNewOrigin("");
    setOriginError(undefined);
    setOriginStatus(`${origin} added. Save settings to apply.`);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setFailure(null);
    const problems: FieldError[] = [];
    if (!name.trim()) problems.push({ fieldId: "company-name", label: "Company name", message: "Enter your company name" });
    else if (name.trim().length > 120) problems.push({ fieldId: "company-name", label: "Company name", message: "Use 120 characters or fewer" });
    if (hicNo.trim().length > 40) problems.push({ fieldId: "hic-no", label: "HIC registration number", message: "Use 40 characters or fewer" });
    const hex = color.trim();
    if (hex && !Theme.shape.color.safeParse(hex).success) {
      problems.push({ fieldId: "brand-color", label: "Brand color", message: "Enter a 6-digit hex color, such as #1f6b3a" });
    }
    if (problems.length > 0) {
      focusSummary.current = true;
      setErrors(problems);
      setSaveStatus("");
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      // The logo key is not edited here; keep whatever is stored.
      const restOfTheme = company.theme.logoKey ? { logoKey: company.theme.logoKey } : {};
      const saved = await api.updateCompany({
        name: name.trim(),
        hicNo: hicNo.trim() || null,
        allowedOrigins: origins,
        theme: hex ? { ...restOfTheme, color: hex } : restOfTheme,
      });
      onSaved(saved);
      setSaveStatus(`Settings saved at ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`);
      toast("Settings saved.");
    } catch (error) {
      setSaveStatus("");
      setFailure(describeError(error));
    } finally {
      setSaving(false);
    }
  }

  const validColor = Theme.shape.color.safeParse(color.trim()).success ? color.trim() : null;
  const colorUse = validColor ? brandColorUse(validColor) : null;

  return (
    <div className="stack">
      <section className="card" aria-labelledby="install-heading">
        <h2 id="install-heading">Put the quote widget on your site</h2>
        <p className="muted">Paste the snippet where the widget should appear. No website? Share the hosted page link instead.</p>
        <CopyBlock id="snippet" label="Embed snippet" value={`<script src="${SCRIPT_ORIGIN}/v1.js" data-company="${company.slug}" async></script>`} />
        <CopyBlock id="hosted" label="Hosted page link" value={`${APP_ORIGIN}/w/${company.slug}`} />
        <QrBlock url={`${APP_ORIGIN}/w/${company.slug}`} slug={company.slug} />
      </section>

      <section className="card" aria-labelledby="origins-heading">
        <h2 id="origins-heading">Where the widget works</h2>
        <p>
          {origins.length === 0
            ? "Your widget works on any website: Squarespace, Wix, WordPress or your own. There’s nothing to set up."
            : `Your widget only works on ${origins.length === 1 ? "this site" : `these ${origins.length} sites`}. Remove them all to let it work on any website.`}
        </p>
        <details className="origin-limit" open={origins.length > 0}>
          <summary>Limit the widget to your own sites (optional)</summary>
          <p className="muted">
            Most businesses don&rsquo;t need this. When you list sites, the widget only loads inside pages on them and only they can request quotes
            with it; the hosted page always works. List each address your site uses, for example with and without <code>www</code>.
          </p>
          {origins.length > 0 && (
            <ul className="origin-list">
              {origins.map((origin) => (
                <li key={origin}>
                  <code>{origin}</code>
                  <Button
                    className="btn quiet"
                    aria-label={`Remove ${origin}`}
                    onPress={() => {
                      setOrigins(origins.filter((o) => o !== origin));
                      setOriginStatus(`${origin} removed. Save settings to apply.`);
                      originInputRef.current?.focus();
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {/* Its own form, so Enter in the field adds the site instead of saving everything. */}
          <form
            className="add-row"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              addOrigin();
            }}
          >
            <TextInput
              id="new-origin"
              label="Website address to allow"
              description="Only the site is kept: https://www.example.com/quote becomes https://www.example.com."
              type="url"
              autoComplete="url"
              value={newOrigin}
              onChange={(value) => {
                setNewOrigin(value);
                setOriginError(undefined);
              }}
              error={originError}
              inputRef={originInputRef}
            />
            <Button type="submit" className="btn">
              Add site
            </Button>
          </form>
          <p role="status" className="muted">
            {originStatus}
          </p>
        </details>
      </section>

      <form onSubmit={save} noValidate className="stack">
        <ErrorSummary errors={errors} summaryRef={summaryRef} />

        <section className="card" aria-labelledby="look-heading">
          <h2 id="look-heading">Company and look</h2>
          <TextInput id="company-name" label="Company name" description="Shown at the top of the widget." autoComplete="organization" value={name} onChange={setName} error={errorFor(errors, "company-name")} />
          <TextInput
            id="hic-no"
            label="HIC registration number (optional)"
            description="Pennsylvania home improvement contractor number. Shown on quotes for non-taxable landscaping services."
            value={hicNo}
            onChange={setHicNo}
            error={errorFor(errors, "hic-no")}
            className="narrow"
          />
          <TextInput
            id="brand-color"
            label="Brand color, as a 6-digit hex code (optional)"
            description="Used for the widget's buttons and accents. Text colors are fixed so the widget stays readable."
            value={color}
            onChange={setColor}
            error={errorFor(errors, "brand-color")}
            className="narrow"
          />
          {validColor && colorUse && (
            <p className="swatch-line">
              {/* The one place the raw brand color is painted; it is validated as #rrggbb first. */}
              <span className="swatch" style={{ background: validColor }} aria-hidden="true" />
              <span>
                {colorUse.use === "fill"
                  ? `${validColor} will fill the widget’s buttons with ${colorUse.text === "#ffffff" ? "white" : "dark"} text (contrast ${colorUse.ratio.toFixed(1)} to 1).`
                  : `${validColor} doesn’t have enough contrast with text to fill buttons (${colorUse.ratio.toFixed(1)} to 1; 4.5 is needed), so the widget will use it as an accent only.`}
              </span>
            </p>
          )}
        </section>

        <section className="card save-bar" aria-label="Save settings">
          <div className="form-actions">
            <BusyButton type="submit" className="btn primary" isBusy={saving}>
              Save settings
            </BusyButton>
          </div>
          <p role="status" className="muted">
            {saveStatus}
          </p>
          {failure && (
            <p role="alert" className="inline-error">
              {failure}
            </p>
          )}
        </section>
      </form>
    </div>
  );
}

export default function EmbedSettingsPage() {
  const api = useApi();
  const { state, reload, set } = useLoad(() => api.getCompany(), [api]);
  return (
    <>
      <PageHeading title="Embed settings" />
      {state.status === "loading" && <Loading what="settings" />}
      {state.status === "error" && <LoadError message={state.message} onRetry={reload} />}
      {state.status === "ready" && <Settings company={state.data} onSaved={set} />}
    </>
  );
}
