// CSV import of tiers. There is no import route: the dashboard reads the file,
// puts the tiers into the draft being edited, and they are saved with it.
// A file imports whole or not at all; every problem is reported with its row
// and column so it can be fixed in the spreadsheet it came from.

import { RegionGroup, ServiceCode, type Tier } from "@lq/api-contract";
import { parseCsv } from "./csv";
import { parseDollars, parseRatePer1000, parseWholeNumber } from "./money";
import { findOverlaps } from "./tiers";

export const TIER_CSV_COLUMNS = ["service_code", "region_group", "min_sqft", "max_sqft", "price_per_1000_sqft", "flat_price"] as const;
type Column = (typeof TIER_CSV_COLUMNS)[number];

export const TIER_CSV_TEMPLATE = [
  TIER_CSV_COLUMNS.join(","),
  "mow,core,0,5000,,45.00",
  "mow,core,5000,10000,7.50,",
  "mow,outer,0,5000,,55.00",
  "",
].join("\r\n");

export const MAX_CSV_BYTES = 1_000_000;
export const MAX_TIERS = 5000;

export type CsvProblem = {
  /** Line in the file, counting the header as 1. Null for a problem with the file as a whole. */
  row: number | null;
  column: string | null;
  problem: string;
};

export type TierImport = { ok: true; tiers: Tier[] } | { ok: false; problems: CsvProblem[] };

export function parseTiersCsv(text: string, serviceCodes: readonly string[]): TierImport {
  const parsed = parseCsv(text);
  if (!parsed.ok) return { ok: false, problems: [{ row: parsed.line, column: null, problem: parsed.problem }] };

  const [header, ...records] = parsed.rows;
  if (!header) return { ok: false, problems: [{ row: null, column: null, problem: "The file is empty" }] };

  const names = header.map((h) => h.trim().toLowerCase());
  const problems: CsvProblem[] = [];
  const index = {} as Record<Column, number>;
  for (const column of TIER_CSV_COLUMNS) {
    index[column] = names.indexOf(column);
    if (index[column] === -1) problems.push({ row: 1, column, problem: "This column is missing from the header row" });
  }
  names.forEach((name, i) => {
    if (!(TIER_CSV_COLUMNS as readonly string[]).includes(name)) {
      problems.push({ row: 1, column: name || `column ${i + 1}`, problem: "This column is not recognized" });
    }
  });
  if (problems.length > 0) return { ok: false, problems };
  if (records.length === 0) return { ok: false, problems: [{ row: null, column: null, problem: "The file has a header row but no tiers" }] };
  if (records.length > MAX_TIERS) {
    return { ok: false, problems: [{ row: null, column: null, problem: `The file has ${records.length} tiers; the most a version can hold is ${MAX_TIERS}` }] };
  }

  const known = new Set(serviceCodes);
  const tiers: Tier[] = [];
  const rowOfTier: number[] = [];

  records.forEach((record, r) => {
    const row = r + 2;
    const before = problems.length;
    const add = (column: Column, problem: string) => problems.push({ row, column, problem });
    const cell = (column: Column) => (record[index[column]] ?? "").trim();

    if (record.length > names.length) problems.push({ row, column: null, problem: `This row has ${record.length} values; the header has ${names.length}` });

    const serviceCode = cell("service_code");
    if (!serviceCode) add("service_code", "A service code is required");
    else if (!ServiceCode.safeParse(serviceCode).success) add("service_code", "Use lowercase letters, digits and underscores only");
    else if (!known.has(serviceCode)) add("service_code", `No service with the code "${serviceCode}" in this version; add the service first`);

    const regionGroup = cell("region_group");
    if (!regionGroup) add("region_group", "A region group is required");
    else if (!RegionGroup.safeParse(regionGroup).success) add("region_group", "Use 40 characters or fewer");

    const minSqft = parseWholeNumber(cell("min_sqft"));
    if (minSqft === null) add("min_sqft", "Enter a whole number of square feet, 0 or more");
    const maxSqft = parseWholeNumber(cell("max_sqft"));
    if (maxSqft === null) add("max_sqft", "Enter a whole number of square feet");
    else if (minSqft !== null && maxSqft <= minSqft) add("max_sqft", "Must be greater than min_sqft");

    const rateText = cell("price_per_1000_sqft");
    const flatText = cell("flat_price");
    let pricePerSqftMicrocents: number | null = null;
    let flatPriceCents: number | null = null;
    if (rateText && flatText) add("flat_price", "Give price_per_1000_sqft or flat_price, not both");
    else if (!rateText && !flatText) add("flat_price", "Give price_per_1000_sqft or flat_price");
    else if (rateText) {
      pricePerSqftMicrocents = parseRatePer1000(rateText);
      if (pricePerSqftMicrocents === null) add("price_per_1000_sqft", "Enter dollars per 1,000 sq ft, such as 7.50");
    } else {
      flatPriceCents = parseDollars(flatText);
      if (flatPriceCents === null) add("flat_price", "Enter a dollar amount, such as 45.00");
    }

    if (problems.length === before && minSqft !== null && maxSqft !== null) {
      tiers.push({ serviceCode, regionGroup, minSqft, maxSqft, pricePerSqftMicrocents, flatPriceCents });
      rowOfTier.push(row);
    }
  });

  if (problems.length === 0) {
    for (const [a, b] of findOverlaps(tiers)) {
      problems.push({ row: rowOfTier[b]!, column: "min_sqft", problem: `This range overlaps row ${rowOfTier[a]!} for the same service and region group` });
    }
  }
  if (problems.length > 0) {
    problems.sort((x, y) => (x.row ?? 0) - (y.row ?? 0));
    return { ok: false, problems };
  }
  return { ok: true, tiers };
}
