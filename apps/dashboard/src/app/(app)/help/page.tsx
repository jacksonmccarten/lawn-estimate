"use client";

import { Link } from "react-aria-components";
import { PageHeading } from "@/components/ui";

export default function HelpPage() {
  return (
    <>
      <PageHeading title="Help" />
      <section className="card prose">
        <h2>How a quote is priced</h2>
        <p>
          Every quote applies your published pricing version to the lawn area the homeowner outlined: the lawn size category it falls in gives one flat
          rate, then sales tax is added at the rate for the property&rsquo;s county. Nothing else goes into a price.
        </p>
        <h2>Changing prices</h2>
        <p>
          Prices change by publishing a new version. Start a draft on the <Link className="link" href="/pricing">Pricing</Link> page, set your categories and
          rates, then review the changes and publish. Quotes that were already sent keep the version they were priced with. To undo a change, roll back to an earlier
          version from the same page.
        </p>
        <h2>Handling a lead</h2>
        <p>
          Open a lead from the <Link className="link" href="/leads">Leads</Link> page to see the contact, the property and the estimate. Accept it as quoted,
          accept it at your own total, or decline it. A lead is decided once.
        </p>
        <h2>Putting the widget on your site</h2>
        <p>
          The snippet and your hosted quote page are on <Link className="link" href="/settings/embed">Embed settings</Link>, along with the list of sites
          allowed to show the widget.
        </p>
      </section>
    </>
  );
}
