-- A company's monthly allowance now counts the estimates it prices. It was
-- a count of Regrid lookups; since the aerial photo replaced Regrid no lookup
-- is ever made, so the allowance never ran out and a trial had no limit.
-- companies.regrid_lookup_quota keeps its name: it is the allowance.
--
-- estimate_context is the same function as in 0009 with one expression
-- changed. It belongs to app_definer, so it is replaced as that role.

GRANT CREATE ON SCHEMA public TO app_definer;
SET LOCAL ROLE app_definer;

CREATE OR REPLACE FUNCTION estimate_context(
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
    -- The allowance is estimates priced this month. (Lookups still count, for
    -- the day a paid lookup returns: whichever is higher.)
    'quota_left', co.regrid_lookup_quota > COALESCE((
      SELECT GREATEST(u.regrid_lookups, u.quotes) FROM public.usage_meters u
      WHERE u.company_id = co.id AND u.month = public.usage_month()), 0),
    'parcel', (
      SELECT jsonb_build_object(
        'regrid_id', pc.regrid_id, 'parcel_sqft', pc.parcel_sqft, 'footprint_sqft', pc.footprint_sqft,
        'state', pc.state, 'county', pc.county, 'zip', pc.zip)
      FROM public.parcel_cache pc WHERE pc.address_norm = p_address_norm)
  );
END
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM app_definer;
