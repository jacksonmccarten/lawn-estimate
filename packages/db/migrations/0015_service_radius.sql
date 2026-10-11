-- A company's service area as the dashboard now asks for it: its business
-- address and how many miles around it it works. The address is the one the
-- owner typed (never geocoded, R16); the radius is measured from the centre
-- of its zip code, and the zips inside are what service_regions stores, so
-- pricing and the tax county are unchanged. Null until the owner sets one.

ALTER TABLE companies
  ADD COLUMN service_street text CHECK (length(service_street) BETWEEN 3 AND 200),
  ADD COLUMN service_city text CHECK (length(service_city) BETWEEN 2 AND 100),
  ADD COLUMN service_state text CHECK (service_state ~ '^[A-Z]{2}$'),
  ADD COLUMN service_zip text CHECK (service_zip ~ '^[0-9]{5}$'),
  ADD COLUMN service_radius_miles numeric(4, 1) CHECK (service_radius_miles BETWEEN 1 AND 100),
  ADD CONSTRAINT companies_service_radius_complete CHECK (
    num_nulls(service_street, service_city, service_state, service_zip, service_radius_miles) IN (0, 5)
  );
