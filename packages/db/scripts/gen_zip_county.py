"""Regenerates zip-to-county rows for one state from the Census Bureau's 2020
ZCTA-to-county relationship file.

    curl -O https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
    python gen_zip_county.py tab20_zcta520_county20_natl.txt 42 PA primary > rows.sql
    python gen_zip_county.py tab20_zcta520_county20_natl.txt 42 PA parts > rows.sql

`primary` (zip_county): one row per ZCTA that overlaps the state, naming the
county of that state holding the largest share of the ZCTA's land area (ties:
more water area, then lower county FIPS). The 2020 file carries areas, not
populations, so "primary" means largest by land area.

`parts` (zip_county_parts): one row per county of that state that holds any of
the ZCTA's land, plus the primary county if it holds none.

Rows go into a new numbered migration; applied migrations are never edited.
"""

import csv
import sys

path, state_fips, state, mode = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
assert mode in ("primary", "parts"), mode

best = {}
parts = set()
with open(path, encoding="utf-8-sig", newline="") as f:
    for row in csv.DictReader(f, delimiter="|"):
        zcta, county_fips = row["GEOID_ZCTA5_20"], row["GEOID_COUNTY_20"]
        if not zcta or not county_fips.startswith(state_fips):
            continue
        name = row["NAMELSAD_COUNTY_20"]
        assert name.endswith(" County"), name
        county = name[: -len(" County")]
        land = int(row["AREALAND_PART"])
        if land > 0:
            parts.add((zcta, county))
        key = (land, int(row["AREAWATER_PART"]), -int(county_fips))
        if zcta not in best or key > best[zcta][0]:
            best[zcta] = (key, county)

primary = {(zcta, county) for zcta, (_, county) in best.items()}
rows = sorted(primary if mode == "primary" else parts | primary)
for i, (zcta, county) in enumerate(rows):
    end = ";" if i == len(rows) - 1 else ","
    print(f"  ('{zcta}', '{state}', '{county}'){end}")
