import type { PricingVersionContent, PricingVersionDiff, Service, Tier } from "@lq/api-contract";
import type { ReactNode } from "react";
import { formatCents, formatRatePer1000, formatSqft } from "@/lib/money";
import { TableScroll } from "../ui";

export const tierRange = (t: Tier) => `Over ${formatSqft(t.minSqft)}, up to ${formatSqft(t.maxSqft)}`;
export const tierPrice = (t: Tier) =>
  t.pricePerSqftMicrocents !== null ? formatRatePer1000(t.pricePerSqftMicrocents) : `${formatCents(t.flatPriceCents ?? 0)} flat`;
const taxLabel = (s: Service) => (s.taxable ? "Taxable" : "Not taxable");
const seasonLabel = (s: Service) => (s.season === "growing" ? "Growing season" : "Winter");

/** A version's content, read-only: what a published version looks like. */
export function VersionContent({ content }: { content: PricingVersionContent }) {
  const serviceName = (code: string) => content.services.find((s) => s.code === code)?.name ?? code;
  return (
    <div className="stack">
      <dl className="details">
        <dt>Minimum charge</dt>
        <dd>{formatCents(content.minChargeCents)}</dd>
      </dl>
      <TableScroll label="Services table">
        <table className="table">
          <caption>Services</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Code</th>
              <th scope="col">Sales tax</th>
              <th scope="col">Season</th>
            </tr>
          </thead>
          <tbody>
            {content.services.map((s) => (
              <tr key={s.code}>
                <th scope="row">{s.name}</th>
                <td>
                  <code>{s.code}</code>
                </td>
                <td>{taxLabel(s)}</td>
                <td>{seasonLabel(s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <TableScroll label="Tiers table">
        <table className="table">
          <caption>Tiers</caption>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Region group</th>
              <th scope="col">Lawn area</th>
              <th scope="col">Price</th>
            </tr>
          </thead>
          <tbody>
            {content.tiers.map((t, i) => (
              <tr key={i}>
                <th scope="row">{serviceName(t.serviceCode)}</th>
                <td>{t.regionGroup}</td>
                <td>{tierRange(t)}</td>
                <td>{tierPrice(t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

function Change({ kind, children }: { kind: "added" | "removed" | "changed"; children: ReactNode }) {
  // The word carries the meaning; the mark and tint only reinforce it (1.4.1).
  const mark = { added: "+", removed: "−", changed: "~" }[kind];
  const word = { added: "Added", removed: "Removed", changed: "Changed" }[kind];
  return (
    <li className={`change change-${kind}`}>
      <span className="change-kind">
        <span aria-hidden="true">{mark} </span>
        {word}
      </span>
      <span>{children}</span>
    </li>
  );
}

const FromTo = ({ from, to }: { from: string; to: string }) => (
  <>
    <del>{from}</del>
    <span className="visually-hidden"> becomes </span>
    <span aria-hidden="true"> → </span>
    <ins>{to}</ins>
  </>
);

/** A draft against the published version, for the first step of publishing. */
export function DiffView({ diff }: { diff: PricingVersionDiff }) {
  const tierLabel = (t: Tier) => `${t.serviceCode}, ${t.regionGroup}, ${tierRange(t).toLowerCase()}`;
  const settings = diff.minChargeCents;
  const services = diff.services.added.length + diff.services.removed.length + diff.services.changed.length;
  const tiers = diff.tiers.added.length + diff.tiers.removed.length + diff.tiers.changed.length;
  return (
    <div className="diff">
      {diff.publishedId === null && <p>Nothing is published yet, so everything in this draft is new.</p>}
      {settings && (
        <>
          <h3>Settings</h3>
          <ul className="changes">
            {diff.minChargeCents && (
              <Change kind="changed">
                Minimum charge: <FromTo from={formatCents(diff.minChargeCents.from)} to={formatCents(diff.minChargeCents.to)} />
              </Change>
            )}
          </ul>
        </>
      )}
      {services > 0 && (
        <>
          <h3>Services ({services})</h3>
          <ul className="changes">
            {diff.services.added.map((s) => (
              <Change key={`a${s.code}`} kind="added">
                {s.name} (<code>{s.code}</code>), {taxLabel(s).toLowerCase()}
              </Change>
            ))}
            {diff.services.removed.map((s) => (
              <Change key={`r${s.code}`} kind="removed">
                {s.name} (<code>{s.code}</code>)
              </Change>
            ))}
            {diff.services.changed.map(({ from, to }) => (
              <Change key={`c${to.code}`} kind="changed">
                {to.name} (<code>{to.code}</code>):{" "}
                {from.name !== to.name && (
                  <>
                    name <FromTo from={from.name} to={to.name} />;{" "}
                  </>
                )}
                {from.taxable !== to.taxable && (
                  <strong>
                    sales tax <FromTo from={taxLabel(from).toLowerCase()} to={taxLabel(to).toLowerCase()} />, which changes what homeowners are charged;{" "}
                  </strong>
                )}
                {from.season !== to.season && (
                  <>
                    season <FromTo from={seasonLabel(from).toLowerCase()} to={seasonLabel(to).toLowerCase()} />
                  </>
                )}
              </Change>
            ))}
          </ul>
        </>
      )}
      {tiers > 0 && (
        <>
          <h3>Tiers ({tiers})</h3>
          <ul className="changes">
            {diff.tiers.added.map((t, i) => (
              <Change key={`a${i}`} kind="added">
                {tierLabel(t)}: {tierPrice(t)}
              </Change>
            ))}
            {diff.tiers.removed.map((t, i) => (
              <Change key={`r${i}`} kind="removed">
                {tierLabel(t)}: {tierPrice(t)}
              </Change>
            ))}
            {diff.tiers.changed.map(({ from, to }, i) => (
              <Change key={`c${i}`} kind="changed">
                {tierLabel(to)}: <FromTo from={tierPrice(from)} to={tierPrice(to)} />
              </Change>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
