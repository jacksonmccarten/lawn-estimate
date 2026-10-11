"use client";

import type { PreviewQuoteResponse, PricingVersionContent } from "@lq/api-contract";
import { useMemo, useState, type FormEvent } from "react";
import { Checkbox, CheckboxGroup, Label } from "react-aria-components";
import { describeError } from "@/lib/api";
import { formatSqft, parseWholeNumber } from "@/lib/money";
import { PA_COUNTIES } from "@/lib/pa-counties";
import { useApi } from "../auth-provider";
import { QuoteLines } from "../quote-lines";
import { BusyButton, SelectField, TextInput } from "../ui";

type Props = {
  versionId: string;
  /** The content as last saved: the preview prices what the server has. */
  content: PricingVersionContent;
  /** For a draft: saves pending edits first. Resolves false if they could not be saved. */
  beforePreview?: () => Promise<boolean>;
};

const COUNTY_OPTIONS = PA_COUNTIES.map((county) => ({ id: county, label: county }));

/**
 * "Preview a quote": the company-api runs packages/pricing on this version,
 * the same package and inputs the estimate route uses, so what is shown here
 * is what a homeowner would be quoted.
 */
export function PreviewQuote({ versionId, content, beforePreview }: Props) {
  const api = useApi();
  const [serviceCode, setServiceCode] = useState("");
  const [addOns, setAddOns] = useState<string[]>([]);
  const [sqft, setSqft] = useState("");
  const [regionGroup, setRegionGroup] = useState("");
  const [county, setCounty] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ response: PreviewQuoteResponse; county: string; sqft: number; regionGroup: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const services = useMemo(() => content.services.map((s) => ({ id: s.code, label: s.name })), [content.services]);
  const regionGroups = useMemo(() => [...new Set(content.tiers.map((t) => t.regionGroup))].sort().map((g) => ({ id: g, label: g })), [content.tiers]);
  const nameOf = (code: string | undefined) => content.services.find((s) => s.code === code)?.name ?? code ?? "that service";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const grassSqft = parseWholeNumber(sqft);
    const problems: Record<string, string> = {};
    if (!serviceCode) problems.service = "Choose a service";
    if (grassSqft === null) problems.sqft = "Enter a whole number of square feet";
    if (!regionGroup) problems.region = "Choose a region group";
    if (!county) problems.county = "Choose a county";
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0 || grassSqft === null) {
      const first = ["service", "sqft", "region", "county"].find((key) => problems[key]);
      document.getElementById(`preview-${first}`)?.focus();
      return;
    }
    setPending(true);
    setResult(null);
    try {
      if (beforePreview && !(await beforePreview())) {
        setFailure("The draft has problems, so it wasn’t saved and can’t be previewed yet. Fix them above, then preview again.");
        return;
      }
      const response = await api.previewQuote(versionId, {
        serviceCode,
        addOnCodes: addOns.filter((code) => code !== serviceCode),
        grassSqft,
        regionGroup,
        county,
      });
      setResult({ response, county, sqft: grassSqft, regionGroup });
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setPending(false);
    }
  }

  const response = result?.response;
  return (
    <section className="card" aria-labelledby="preview-heading">
      <h2 id="preview-heading">Preview a quote</h2>
      <p className="muted">
        See what a homeowner would be quoted with this version.{beforePreview ? " Unsaved changes to the draft are saved first." : ""}
      </p>
      <form onSubmit={submit} noValidate className="preview-form">
        <SelectField id="preview-service" label="Service" value={serviceCode} onChange={setServiceCode} options={services} error={errors.service} />
        <TextInput id="preview-sqft" label="Lawn area, sq ft" inputMode="numeric" value={sqft} onChange={setSqft} error={errors.sqft} />
        <SelectField id="preview-region" label="Region group" value={regionGroup} onChange={setRegionGroup} options={regionGroups} error={errors.region} />
        <SelectField id="preview-county" label="County, for sales tax" value={county} onChange={setCounty} options={COUNTY_OPTIONS} error={errors.county} />
        {services.length > 1 && (
          <CheckboxGroup className="checkbox-group" value={addOns} onChange={setAddOns}>
            <Label>Add-on services</Label>
            {services
              .filter((s) => s.id !== serviceCode)
              .map((s) => (
                <Checkbox key={s.id} value={s.id} className="checkbox">
                  <span className="checkbox-box" aria-hidden="true" />
                  {s.label}
                </Checkbox>
              ))}
          </CheckboxGroup>
        )}
        <div className="form-actions">
          <BusyButton type="submit" className="btn" isBusy={pending}>
            Preview quote
          </BusyButton>
        </div>
      </form>
      <div aria-live="polite" className="preview-result">
        {failure && <p className="inline-error">{failure}</p>}
        {response?.status === "priced" && (
          <>
            <p>
              Estimate for {formatSqft(result!.sqft)} of lawn in the {result!.regionGroup} region group. This is an estimate, not a contract.
            </p>
            <QuoteLines quote={response.quote} county={result!.county} caption="Previewed quote" />
          </>
        )}
        {response?.status === "no_price" && (
          <p className="notice">
            {response.reason === "no_tier" &&
              `No tier covers ${formatSqft(result!.sqft)} for ${nameOf(response.serviceCode)} in the ${result!.regionGroup} region group. A homeowner with this lawn would be asked to call you instead of seeing a price.`}
            {response.reason === "unknown_service" && `This version doesn’t include ${nameOf(response.serviceCode)}.`}
            {response.reason === "unknown_county" &&
              `There is no sales tax rate on file for ${result!.county} County, so no price is shown. A default rate is never used.`}
          </p>
        )}
      </div>
    </section>
  );
}
