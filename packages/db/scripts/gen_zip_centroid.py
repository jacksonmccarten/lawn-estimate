"""Regenerates zip-code centre points from the Census Bureau's 2023 ZCTA
gazetteer file, for the zips a zip_county migration already lists.

    curl -O https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip
    unzip 2023_Gaz_zcta_national.zip
    python gen_zip_centroid.py 2023_Gaz_zcta_national.txt ../migrations/0006_zip_county.sql > rows.sql

One row per zip: the latitude and longitude of the ZCTA's internal point,
which the Census Bureau places inside the area, near its centre.

Rows go into a new numbered migration; applied migrations are never edited.
"""

import csv
import re
import sys

gazetteer, zip_county_sql = sys.argv[1], sys.argv[2]

wanted = set(re.findall(r"\('(\d{5})', '[A-Z]{2}', ", open(zip_county_sql, encoding="utf-8").read()))
assert wanted, "no zips found in the zip_county migration"

points = {}
with open(gazetteer, encoding="utf-8-sig", newline="") as f:
    for row in csv.DictReader(f, delimiter="\t"):
        row = {k.strip(): v.strip() for k, v in row.items()}
        if row["GEOID"] in wanted:
            points[row["GEOID"]] = (float(row["INTPTLAT"]), float(row["INTPTLONG"]))

missing = sorted(wanted - points.keys())
assert not missing, f"no centre point for: {missing[:10]}"

rows = [f"  ('{z}', {lat:.6f}, {lng:.6f})" for z, (lat, lng) in sorted(points.items())]
print("INSERT INTO zip_centroid (zip, lat, lng) VALUES")
print(",\n".join(rows) + ";")
