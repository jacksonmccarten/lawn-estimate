-- The widget can be embedded on any website by default. A company with an
-- empty allowlist (every new company, and every company that has not set
-- one) now accepts any embedding origin; a company that lists sites is still
-- held to them. The hosted page reports no origin and is always allowed.
-- Turnstile and the monthly allowance still guard every estimate.

CREATE OR REPLACE FUNCTION origin_allowed(p_allowed text[], p_origin text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  RETURN p_origin IS NULL
    OR COALESCE(cardinality(p_allowed), 0) = 0
    OR lower(p_origin) IN (SELECT lower(o) FROM unnest(p_allowed) AS o);
