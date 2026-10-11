-- Step 4: what the estimate and submit Lambdas need from the database.
--
-- Those routes run as app_public (withPublic), which has no table privileges.
-- Everything they do goes through the SECURITY DEFINER functions below, each
-- owned by app_definer, each taking the company slug and resolving it itself.
-- All changes are additive, so the previous code keeps working.

-- ---- columns

-- phone: shown to a homeowner who is asked to call. alert_email, alert_phone:
-- where lead alerts go (never public). regrid_lookup_quota: Regrid lookups a
-- month; zero until a subscription or an approved trial sets it (section 9).
ALTER TABLE companies
  ADD COLUMN phone text,
  ADD COLUMN alert_email text CHECK (alert_email LIKE '%_@_%'),
  ADD COLUMN alert_phone text CHECK (alert_phone ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN regrid_lookup_quota integer NOT NULL DEFAULT 0 CHECK (regrid_lookup_quota >= 0);

-- Tax rates are keyed on (state, county), and regions on zip.
ALTER TABLE parcel_cache
  ADD COLUMN state text,
  ADD COLUMN zip text;

-- The estimate before the homeowner's one adjustment; NULL if never adjusted.
ALTER TABLE quotes
  ADD COLUMN original_grass_sqft integer CHECK (original_grass_sqft >= 0);

-- Set when an SMS alert went out for the lead; counts toward the daily cap.
ALTER TABLE leads
  ADD COLUMN sms_sent_at timestamptz;

-- ---- app_definer: grants and policies for the functions below

GRANT SELECT (allowed_origins, phone, alert_email, alert_phone, regrid_lookup_quota) ON companies TO app_definer;
GRANT SELECT (min_charge_cents, coverage_factor) ON pricing_versions TO app_definer;
GRANT SELECT (id, company_id, taxable) ON services TO app_definer;
GRANT SELECT (tier_group) ON service_regions TO app_definer;
GRANT SELECT ON pricing_tiers TO app_definer;
GRANT SELECT, INSERT, UPDATE ON quotes, leads, usage_meters, parcel_cache TO app_definer;

CREATE POLICY pricing_tiers_definer ON pricing_tiers FOR SELECT TO app_definer USING (true);
-- No DELETE privilege is granted, so these cover SELECT, INSERT and UPDATE.
-- Every function filters on the company it resolved from the slug.
CREATE POLICY quotes_definer ON quotes TO app_definer USING (true) WITH CHECK (true);
CREATE POLICY leads_definer ON leads TO app_definer USING (true) WITH CHECK (true);
CREATE POLICY usage_meters_definer ON usage_meters TO app_definer USING (true) WITH CHECK (true);

-- ---- helpers (not callable by app_public)

-- The hosted page reports no embedding origin and is always allowed; an
-- embedded widget must be on the company's list.
CREATE FUNCTION origin_allowed(p_allowed text[], p_origin text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  RETURN p_origin IS NULL OR lower(p_origin) IN (SELECT lower(o) FROM unnest(p_allowed) AS o);

-- Usage is metered by calendar month, UTC.
CREATE FUNCTION usage_month() RETURNS date
  LANGUAGE sql STABLE
  RETURN date_trunc('month', now() AT TIME ZONE 'UTC')::date;

GRANT EXECUTE ON FUNCTION origin_allowed(text[], text), usage_month() TO app_definer, app_rw;

-- ---- /estimate

-- The gate, read before anything else happens: is the embedding origin
-- allowed, is the company within its quota, does it sell the service, could
-- the zip be in a region, and is the address already in the parcel cache.
-- `region` is 'in' when a zip region matches or a county region matches any
-- county the zip touches; the region group itself is settled at pricing time.
CREATE FUNCTION estimate_context(
  p_slug text, p_embed_origin text, p_service text, p_address_norm text, p_zip text
) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  co record;
  v_version uuid;
  v_region text := 'unknown';
BEGIN
  SELECT c.id, c.allowed_origins, c.phone, c.regrid_lookup_quota INTO co
  FROM public.companies c WHERE c.slug = p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no company has this slug' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT v.id INTO v_version FROM public.pricing_versions v
  WHERE v.company_id = co.id AND v.published_at IS NOT NULL
  ORDER BY v.version DESC LIMIT 1;

  IF p_zip IS NOT NULL THEN
    v_region := CASE WHEN EXISTS (
      SELECT 1 FROM public.service_regions r
      WHERE r.company_id = co.id
        AND ((r.kind = 'zip' AND r.value = p_zip)
          OR (r.kind = 'county' AND lower(r.value) IN (
                SELECT lower(p.county) FROM public.zip_county_parts p WHERE p.zip = p_zip)))
    ) THEN 'in' ELSE 'out' END;
  END IF;

  RETURN jsonb_build_object(
    'origin_allowed', public.origin_allowed(co.allowed_origins, p_embed_origin),
    'phone', co.phone,
    'service_offered', EXISTS (
      SELECT 1 FROM public.services s WHERE s.version_id = v_version AND s.code = p_service),
    'region', v_region,
    'quota_left', co.regrid_lookup_quota > COALESCE((
      SELECT u.regrid_lookups FROM public.usage_meters u
      WHERE u.company_id = co.id AND u.month = public.usage_month()), 0),
    'parcel', (
      SELECT jsonb_build_object(
        'regrid_id', pc.regrid_id, 'parcel_sqft', pc.parcel_sqft, 'footprint_sqft', pc.footprint_sqft,
        'state', pc.state, 'county', pc.county, 'zip', pc.zip)
      FROM public.parcel_cache pc WHERE pc.address_norm = p_address_norm)
  );
END
$$;

-- Meters one Regrid lookup, before the call is made, or refuses it: the
-- company is at its monthly quota, or all companies together are at the
-- global cap of 8,000 a month (R13). The lock makes check and count one step.
CREATE FUNCTION regrid_reserve_lookup(p_slug text) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  global_cap CONSTANT integer := 8000;
  co record;
  v_month date := public.usage_month();
  v_company integer;
  v_global bigint;
  v_reason text;
BEGIN
  SELECT c.id, c.regrid_lookup_quota INTO co FROM public.companies c WHERE c.slug = p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no company has this slug' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('lq.regrid_meter'));
  SELECT COALESCE(sum(u.regrid_lookups), 0),
         COALESCE(sum(u.regrid_lookups) FILTER (WHERE u.company_id = co.id), 0)
  INTO v_global, v_company
  FROM public.usage_meters u WHERE u.month = v_month;

  IF v_company >= co.regrid_lookup_quota THEN
    v_reason := 'company_quota';
  ELSIF v_global >= global_cap THEN
    v_reason := 'global_cap';
  ELSE
    INSERT INTO public.usage_meters AS u (company_id, month, regrid_lookups)
    VALUES (co.id, v_month, 1)
    ON CONFLICT (company_id, month) DO UPDATE SET regrid_lookups = u.regrid_lookups + 1;
    v_company := v_company + 1;
    v_global := v_global + 1;
  END IF;

  RETURN jsonb_build_object(
    'allowed', v_reason IS NULL, 'reason', v_reason,
    'company_lookups', v_company, 'company_quota', co.regrid_lookup_quota,
    'global_lookups', v_global, 'global_cap', global_cap);
END
$$;

-- Stores a Regrid match. A cache, not a record: no quote refers to it (R10).
CREATE FUNCTION parcel_cache_put(
  p_address_norm text, p_regrid_id text, p_parcel_sqft integer, p_footprint_sqft integer,
  p_state text, p_county text, p_zip text
) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.parcel_cache AS pc (address_norm, regrid_id, parcel_sqft, footprint_sqft, state, county, zip)
  VALUES (p_address_norm, p_regrid_id, p_parcel_sqft, p_footprint_sqft, p_state, p_county, p_zip)
  ON CONFLICT (address_norm) DO UPDATE SET
    regrid_id = EXCLUDED.regrid_id, parcel_sqft = EXCLUDED.parcel_sqft, footprint_sqft = EXCLUDED.footprint_sqft,
    state = EXCLUDED.state, county = EXCLUDED.county, zip = EXCLUDED.zip, cached_at = now()
$$;

-- The service and the tiers of one pricing version that can price one
-- service in one region group; nothing else of the rate table leaves.
CREATE FUNCTION pricing_slice(p_version uuid, p_service text, p_region_group text) RETURNS jsonb
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  RETURN (
    SELECT jsonb_build_object(
      'version_id', v.id,
      'min_charge_cents', v.min_charge_cents,
      'coverage_hundredths', round(v.coverage_factor * 100)::integer,
      'service', (
        SELECT jsonb_build_object('code', s.code, 'name', s.name, 'taxable', s.taxable)
        FROM public.services s WHERE s.version_id = v.id AND s.code = p_service),
      'tiers', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'min_sqft', t.min_sqft, 'max_sqft', t.max_sqft,
          'price_per_sqft_microcents', t.price_per_sqft_microcents, 'flat_price_cents', t.flat_price_cents)
          ORDER BY t.min_sqft)
        FROM public.pricing_tiers t
        JOIN public.services s ON s.id = t.service_id
        WHERE t.version_id = v.id AND s.code = p_service AND t.region_group = p_region_group), '[]'::jsonb))
    FROM public.pricing_versions v WHERE v.id = p_version);

GRANT EXECUTE ON FUNCTION pricing_slice(uuid, text, text) TO app_definer;

-- What packages/pricing needs to price one service at one place: the
-- company's current published version (sliced as above), the region group
-- (a zip region wins over a county region) and the county's tax rate today.
-- `county` comes back as tax_rates spells it. A NULL tax_rate_bps means no
-- rate is on file for that state and county: the caller must not price (R4).
CREATE FUNCTION estimate_pricing_input(
  p_slug text, p_service text, p_zip text, p_state text, p_county text
) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid;
  v_version uuid;
  v_county text;
  v_rate integer;
  v_group text;
BEGIN
  SELECT c.id INTO v_company FROM public.companies c WHERE c.slug = p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no company has this slug' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT v.id INTO v_version FROM public.pricing_versions v
  WHERE v.company_id = v_company AND v.published_at IS NOT NULL
  ORDER BY v.version DESC LIMIT 1;

  SELECT t.county, round(t.rate * 10000)::integer INTO v_county, v_rate
  FROM public.tax_rates t
  WHERE t.state = upper(p_state) AND lower(t.county) = lower(p_county) AND t.effective_from <= current_date
  ORDER BY t.effective_from DESC LIMIT 1;

  SELECT r.tier_group INTO v_group FROM public.service_regions r
  WHERE r.company_id = v_company
    AND ((r.kind = 'zip' AND r.value = p_zip)
      OR (r.kind = 'county' AND lower(r.value) = lower(COALESCE(v_county, p_county))))
  ORDER BY (r.kind = 'zip') DESC LIMIT 1;

  RETURN COALESCE(public.pricing_slice(v_version, p_service, v_group), '{}'::jsonb)
    || jsonb_build_object('region_group', v_group, 'county', v_county, 'tax_rate_bps', v_rate);
END
$$;

-- Inserts a priced quote, pinned to a published version of this company, and
-- counts it. The numbers were computed by packages/pricing in the Lambda.
CREATE FUNCTION estimate_insert_quote(p_slug text, p_quote jsonb) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company uuid;
  v_version uuid := (p_quote ->> 'version_id')::uuid;
  v_id uuid;
BEGIN
  SELECT c.id INTO v_company FROM public.companies c WHERE c.slug = p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no company has this slug' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pricing_versions v
    WHERE v.id = v_version AND v.company_id = v_company AND v.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'not a published pricing version of this company' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.quotes (
    company_id, version_id, address_text, zip, county, region_group, parcel_sqft, footprint_sqft,
    grass_sqft, origin, line_items, tax_rate, tax_cents, total_cents, regrid_parcel_id,
    turnstile_ok, ip_hash, host_origin)
  VALUES (
    v_company, v_version, p_quote ->> 'address_text', p_quote ->> 'zip', p_quote ->> 'county',
    p_quote ->> 'region_group', (p_quote ->> 'parcel_sqft')::integer, (p_quote ->> 'footprint_sqft')::integer,
    (p_quote ->> 'grass_sqft')::integer, p_quote ->> 'origin', p_quote -> 'line_items',
    (p_quote ->> 'tax_rate_bps')::numeric / 10000, (p_quote ->> 'tax_cents')::integer,
    (p_quote ->> 'total_cents')::integer, p_quote ->> 'regrid_parcel_id',
    COALESCE((p_quote ->> 'turnstile_ok')::boolean, false), p_quote ->> 'ip_hash', p_quote ->> 'host_origin')
  RETURNING id INTO v_id;

  INSERT INTO public.usage_meters AS u (company_id, month, quotes)
  VALUES (v_company, public.usage_month(), 1)
  ON CONFLICT (company_id, month) DO UPDATE SET quotes = u.quotes + 1;

  RETURN v_id;
END
$$;

-- A quote as the adjust call needs it, with the slice of its pinned version,
-- so the adjusted price comes from the same rates and tax rate as the first.
-- NULL if this company has no such quote.
CREATE FUNCTION estimate_quote_for_adjust(p_slug text, p_quote_id uuid, p_embed_origin text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT public.pricing_slice(q.version_id, q.line_items -> 0 ->> 'serviceCode', q.region_group)
    || jsonb_build_object(
      'origin_allowed', public.origin_allowed(c.allowed_origins, p_embed_origin),
      'phone', c.phone,
      'status', q.status, 'origin', q.origin, 'grass_sqft', q.grass_sqft,
      'parcel_sqft', q.parcel_sqft, 'footprint_sqft', q.footprint_sqft, 'county', q.county,
      'region_group', q.region_group, 'tax_rate_bps', round(q.tax_rate * 10000)::integer)
  FROM public.quotes q
  JOIN public.companies c ON c.id = q.company_id
  WHERE q.id = p_quote_id AND c.slug = p_slug
$$;

-- The homeowner's one adjustment: only a priced quote that still has its
-- Regrid estimate changes. False means nothing changed.
CREATE FUNCTION estimate_apply_adjustment(p_slug text, p_quote_id uuid, p_quote jsonb) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.quotes q SET
    original_grass_sqft = q.grass_sqft,
    grass_sqft = (p_quote ->> 'grass_sqft')::integer,
    origin = 'regrid_adjusted',
    line_items = p_quote -> 'line_items',
    tax_cents = (p_quote ->> 'tax_cents')::integer,
    total_cents = (p_quote ->> 'total_cents')::integer
  WHERE q.id = p_quote_id
    AND q.company_id = (SELECT c.id FROM public.companies c WHERE c.slug = p_slug)
    AND q.status = 'priced' AND q.origin = 'regrid';
  RETURN FOUND;
END
$$;

-- ---- /submit

-- Turns a priced quote into a lead. `result` is one of: created,
-- already_submitted (a repeat of the same submit; nothing changes),
-- origin_not_allowed, not_found. On created, the rest is what the alert to
-- the company needs. `notify` is false when the same phone or email already
-- sent this company a lead in the last 24 hours; `sms_ok` is false once 30
-- SMS alerts went out in that time.
CREATE FUNCTION submit_lead(
  p_slug text, p_quote_id uuid, p_embed_origin text, p_name text, p_phone text, p_email text
) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  sms_daily_cap CONSTANT integer := 30;
  co record;
  q record;
  v_duplicate boolean;
  v_lead uuid;
BEGIN
  SELECT c.id, c.name, c.allowed_origins, c.alert_email, c.alert_phone INTO co
  FROM public.companies c WHERE c.slug = p_slug;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no company has this slug' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT public.origin_allowed(co.allowed_origins, p_embed_origin) THEN
    RETURN jsonb_build_object('result', 'origin_not_allowed');
  END IF;

  SELECT * INTO q FROM public.quotes x WHERE x.id = p_quote_id AND x.company_id = co.id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;
  IF q.status <> 'priced' THEN
    RETURN jsonb_build_object('result', 'already_submitted');
  END IF;

  v_duplicate := EXISTS (
    SELECT 1 FROM public.leads l
    WHERE l.company_id = co.id AND l.created_at > now() - interval '24 hours'
      AND ((p_email IS NOT NULL AND lower(l.email) = lower(p_email))
        OR (p_phone IS NOT NULL
            AND regexp_replace(l.phone, '[^0-9]', '', 'g') = regexp_replace(p_phone, '[^0-9]', '', 'g'))));

  INSERT INTO public.leads (quote_id, company_id, name, phone, email)
  VALUES (q.id, co.id, p_name, p_phone, p_email)
  RETURNING id INTO v_lead;
  UPDATE public.quotes SET status = 'submitted' WHERE id = q.id;

  RETURN jsonb_build_object(
    'result', 'created', 'lead_id', v_lead, 'notify', NOT v_duplicate,
    'company_name', co.name, 'alert_email', co.alert_email, 'alert_phone', co.alert_phone,
    'sms_ok', (SELECT count(*) FROM public.leads l
               WHERE l.company_id = co.id AND l.sms_sent_at > now() - interval '24 hours') < sms_daily_cap,
    'address_text', q.address_text, 'county', q.county, 'grass_sqft', q.grass_sqft,
    'line_items', q.line_items, 'tax_cents', q.tax_cents, 'total_cents', q.total_cents);
END
$$;

-- Records that the company was alerted about a lead, and whether by SMS too.
CREATE FUNCTION lead_mark_notified(p_slug text, p_lead_id uuid, p_sms boolean) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  UPDATE public.leads l SET
    notified_at = now(),
    sms_sent_at = CASE WHEN p_sms THEN now() ELSE l.sms_sent_at END
  WHERE l.id = p_lead_id
    AND l.company_id = (SELECT c.id FROM public.companies c WHERE c.slug = p_slug)
$$;

-- ---- grants, then the hand-over (EXECUTE is not PUBLIC by default; grant
-- before the owner changes)

GRANT EXECUTE ON FUNCTION
  estimate_context(text, text, text, text, text),
  regrid_reserve_lookup(text),
  parcel_cache_put(text, text, integer, integer, text, text, text),
  estimate_pricing_input(text, text, text, text, text),
  estimate_insert_quote(text, jsonb),
  estimate_quote_for_adjust(text, uuid, text),
  estimate_apply_adjustment(text, uuid, jsonb),
  submit_lead(text, uuid, text, text, text, text),
  lead_mark_notified(text, uuid, boolean)
TO app_public;

GRANT CREATE ON SCHEMA public TO app_definer;
ALTER FUNCTION estimate_context(text, text, text, text, text) OWNER TO app_definer;
ALTER FUNCTION regrid_reserve_lookup(text) OWNER TO app_definer;
ALTER FUNCTION parcel_cache_put(text, text, integer, integer, text, text, text) OWNER TO app_definer;
ALTER FUNCTION estimate_pricing_input(text, text, text, text, text) OWNER TO app_definer;
ALTER FUNCTION estimate_insert_quote(text, jsonb) OWNER TO app_definer;
ALTER FUNCTION estimate_quote_for_adjust(text, uuid, text) OWNER TO app_definer;
ALTER FUNCTION estimate_apply_adjustment(text, uuid, jsonb) OWNER TO app_definer;
ALTER FUNCTION submit_lead(text, uuid, text, text, text, text) OWNER TO app_definer;
ALTER FUNCTION lead_mark_notified(text, uuid, boolean) OWNER TO app_definer;
REVOKE CREATE ON SCHEMA public FROM app_definer;
