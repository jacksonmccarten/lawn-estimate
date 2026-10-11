-- Schema for docs/ENGINEERING_DESIGN.md section 7.
-- Money is integer cents. Company-scoped tables all carry company_id so one
-- RLS predicate covers them; composite foreign keys keep a child row's
-- company_id equal to its parent's.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE companies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name               text NOT NULL,
  hic_no             text,
  allowed_origins    text[] NOT NULL DEFAULT '{}',
  theme              jsonb NOT NULL DEFAULT '{}',
  stripe_customer_id text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- One company per Cognito user; `admin` is a Cognito group, not a row.
CREATE TABLE company_members (
  cognito_sub text PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies (id),
  role        text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX company_members_company_idx ON company_members (company_id);

CREATE TABLE service_regions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  kind       text NOT NULL CHECK (kind IN ('zip', 'county')),
  value      text NOT NULL,
  tier_group text NOT NULL,
  UNIQUE (company_id, kind, value)
);

-- Immutable once published_at is set (see the triggers below).
CREATE TABLE pricing_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies (id),
  version          integer NOT NULL CHECK (version > 0),
  min_charge_cents integer NOT NULL DEFAULT 0 CHECK (min_charge_cents >= 0),
  coverage_factor  numeric(3, 2) NOT NULL DEFAULT 0.70 CHECK (coverage_factor > 0 AND coverage_factor <= 1),
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, version),
  UNIQUE (id, company_id)
);

-- taxable has no default on purpose: every service states it (R1).
CREATE TABLE services (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL,
  company_id uuid NOT NULL,
  code       text NOT NULL,
  name       text NOT NULL,
  taxable    boolean NOT NULL,
  season     text NOT NULL DEFAULT 'growing' CHECK (season IN ('growing', 'winter')),
  FOREIGN KEY (version_id, company_id) REFERENCES pricing_versions (id, company_id),
  UNIQUE (version_id, code),
  UNIQUE (id, version_id)
);

-- A tier covers min_sqft < grass_sqft <= max_sqft and carries exactly one of
-- a per-sqft rate or a flat price. Overlapping tiers are rejected.
CREATE TABLE pricing_tiers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id                uuid NOT NULL,
  company_id                uuid NOT NULL,
  service_id                uuid NOT NULL,
  region_group              text NOT NULL,
  min_sqft                  integer NOT NULL CHECK (min_sqft >= 0),
  max_sqft                  integer NOT NULL,
  price_per_sqft_microcents integer CHECK (price_per_sqft_microcents >= 0),
  flat_price_cents          integer CHECK (flat_price_cents >= 0),
  FOREIGN KEY (version_id, company_id) REFERENCES pricing_versions (id, company_id),
  FOREIGN KEY (service_id, version_id) REFERENCES services (id, version_id),
  CHECK (max_sqft > min_sqft),
  CHECK (num_nonnulls(price_per_sqft_microcents, flat_price_cents) = 1),
  EXCLUDE USING gist (
    version_id WITH =,
    service_id WITH =,
    region_group WITH =,
    int4range(min_sqft, max_sqft, '(]') WITH &&
  )
);

-- Published pricing is immutable for every role, the owner included. The
-- triggers raise so a blocked write is never mistaken for a successful one;
-- an UPDATE filtered out by RLS alone would just report zero rows.
CREATE FUNCTION pricing_versions_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'pricing version % is published and cannot be changed', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pricing_versions_immutable
  BEFORE UPDATE OR DELETE ON pricing_versions
  FOR EACH ROW EXECUTE FUNCTION pricing_versions_immutable();

-- Same rule for the rows that belong to a version.
CREATE FUNCTION pricing_children_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  published uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT v.id INTO published FROM pricing_versions v
    WHERE v.id = OLD.version_id AND v.published_at IS NOT NULL;
  END IF;
  IF published IS NULL AND TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT v.id INTO published FROM pricing_versions v
    WHERE v.id = NEW.version_id AND v.published_at IS NOT NULL;
  END IF;
  IF published IS NOT NULL THEN
    RAISE EXCEPTION 'pricing version % is published; its % cannot be changed', published, TG_TABLE_NAME
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER services_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON services
  FOR EACH ROW EXECUTE FUNCTION pricing_children_immutable();
CREATE TRIGGER pricing_tiers_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON pricing_tiers
  FOR EACH ROW EXECUTE FUNCTION pricing_children_immutable();

-- regrid_parcel_id is text with no foreign key: parcel_cache must stay
-- truncatable without touching a quote (R10).
CREATE TABLE quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies (id),
  version_id       uuid NOT NULL,
  status           text NOT NULL DEFAULT 'priced'
                   CHECK (status IN ('priced', 'submitted', 'accepted', 'declined', 'expired')),
  address_text     text NOT NULL,
  zip              text,
  county           text NOT NULL,
  region_group     text NOT NULL,
  parcel_sqft      integer,
  footprint_sqft   integer,
  grass_sqft       integer NOT NULL CHECK (grass_sqft >= 0),
  origin           text NOT NULL CHECK (origin IN ('regrid', 'regrid_adjusted', 'bucket', 'manual')),
  line_items       jsonb NOT NULL CHECK (jsonb_typeof(line_items) = 'array'),
  tax_rate         numeric(5, 4) NOT NULL CHECK (tax_rate >= 0 AND tax_rate < 1),
  tax_cents        integer NOT NULL CHECK (tax_cents >= 0),
  total_cents      integer NOT NULL CHECK (total_cents >= 0),
  regrid_parcel_id text,
  turnstile_ok     boolean NOT NULL DEFAULT false,
  ip_hash          text,
  host_origin      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (version_id, company_id) REFERENCES pricing_versions (id, company_id),
  UNIQUE (id, company_id)
);
CREATE INDEX quotes_company_created_idx ON quotes (company_id, created_at DESC);
CREATE INDEX quotes_status_created_idx ON quotes (status, created_at);

CREATE TABLE leads (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id             uuid NOT NULL UNIQUE,
  company_id           uuid NOT NULL,
  name                 text NOT NULL,
  phone                text,
  email                text,
  decision             text CHECK (decision IN ('accepted', 'declined')),
  adjusted_total_cents integer CHECK (adjusted_total_cents >= 0),
  notified_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (quote_id, company_id) REFERENCES quotes (id, company_id),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX leads_company_created_idx ON leads (company_id, created_at DESC);

CREATE TABLE usage_meters (
  company_id     uuid NOT NULL REFERENCES companies (id),
  month          date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  regrid_lookups integer NOT NULL DEFAULT 0 CHECK (regrid_lookups >= 0),
  quotes         integer NOT NULL DEFAULT 0 CHECK (quotes >= 0),
  PRIMARY KEY (company_id, month)
);

-- One row each time a member of the admin group acts as a company. Written by
-- withCompany() in its own transaction; app_rw can insert but never read,
-- change or delete.
CREATE TABLE admin_access_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies (id),
  admin_sub  text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_access_log_company_idx ON admin_access_log (company_id, at DESC);

-- Global tables: not company-scoped, no RLS, nothing references them.

-- A cache, not a record. Keyed by normalized address because one parcel can
-- have several addresses.
CREATE TABLE parcel_cache (
  address_norm   text PRIMARY KEY,
  regrid_id      text NOT NULL,
  parcel_sqft    integer,
  footprint_sqft integer,
  county         text,
  cached_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcel_cache_regrid_idx ON parcel_cache (regrid_id);

-- Looked up by the county of the service address; the latest row with
-- effective_from <= the quote date applies. A missing county is an error,
-- never a default rate.
CREATE TABLE tax_rates (
  state          text NOT NULL,
  county         text NOT NULL,
  rate           numeric(5, 4) NOT NULL CHECK (rate >= 0 AND rate < 1),
  effective_from date NOT NULL,
  PRIMARY KEY (state, county, effective_from)
);

-- The seeded list a company's services default their taxable flag from (R1).
CREATE TABLE service_catalog (
  state   text NOT NULL,
  code    text NOT NULL,
  name    text NOT NULL,
  taxable boolean NOT NULL,
  season  text NOT NULL DEFAULT 'growing' CHECK (season IN ('growing', 'winter')),
  note    text,
  PRIMARY KEY (state, code)
);
