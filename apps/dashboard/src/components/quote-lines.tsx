import type { QuoteTotals } from "@lq/api-contract";
import { formatBps, formatCents } from "@/lib/money";
import { TableScroll } from "./ui";

/**
 * A quote's line items and totals. Taxable and non-taxable lines stay separate
 * and tax is shown against the taxable subtotal only, with its county (R1–R4).
 */
export function QuoteLines({ quote, county, caption }: { quote: QuoteTotals; county: string; caption: string }) {
  return (
    <TableScroll label={caption}>
      <table className="table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Sales tax</th>
            <th scope="col" className="num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {quote.lines.map((line) => (
            <tr key={line.serviceCode}>
              <th scope="row">{line.name}</th>
              <td>{line.taxable ? "Taxable" : "Not taxable"}</td>
              <td className="num">{formatCents(line.amountCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              Subtotal
            </th>
            <td className="num">{formatCents(quote.subtotalCents)}</td>
          </tr>
          <tr>
            <th scope="row" colSpan={2}>
              Sales tax, {county} County, {formatBps(quote.taxRateBps)} on {formatCents(quote.taxableSubtotalCents)} of taxable services
            </th>
            <td className="num">{formatCents(quote.taxCents)}</td>
          </tr>
          <tr className="total-row">
            <th scope="row" colSpan={2}>
              Estimated total
            </th>
            <td className="num">{formatCents(quote.totalCents)}</td>
          </tr>
        </tfoot>
      </table>
    </TableScroll>
  );
}
