-- Self sign-up: a person who has made a login creates their own company.
-- They belong to no company yet, so withCompany cannot run for them; this
-- one function is what a new login may do, and it does it once.

-- The estimates a new company may price each month until billing sets its
-- allowance: enough to try the product, too few to run up our costs.
-- (The column still carries its Regrid name; see the Decisions table.)

GRANT INSERT (id, slug, name, alert_email, regrid_lookup_quota) ON companies TO app_definer;
GRANT INSERT (cognito_sub, company_id) ON company_members TO app_definer;
GRANT INSERT (company_id, kind, value, tier_group) ON service_regions TO app_definer;
GRANT SELECT (state, county) ON tax_rates TO app_definer;

-- Inserts only; every existing policy for this role is a SELECT.
CREATE POLICY companies_definer_insert ON companies FOR INSERT TO app_definer WITH CHECK (true);
CREATE POLICY company_members_definer_insert ON company_members FOR INSERT TO app_definer WITH CHECK (true);
CREATE POLICY service_regions_definer_insert ON service_regions FOR INSERT TO app_definer WITH CHECK (true);

-- Creates a company owned by the login `p_sub`, and returns its id.
--   * One company per login: a second call raises unique_violation (23505).
--   * The slug comes from the name; a taken slug gets -2, -3, and so on.
--   * It starts with a trial allowance, lead alerts to the owner's own
--     address, and every Pennsylvania county as its service area in one
--     region group, 'standard'. It has no pricing: nothing is quoted until
--     the owner publishes a version of their own.
CREATE FUNCTION create_company_for_sub(p_sub text, p_name text, p_email text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_base text;
  v_slug text;
  v_n integer := 1;
BEGIN
  IF p_sub IS NULL OR p_sub = '' OR btrim(COALESCE(p_name, '')) = '' THEN
    RAISE EXCEPTION 'a login and a company name are required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_members m WHERE m.cognito_sub = p_sub) THEN
    RAISE EXCEPTION 'this login already has a company' USING ERRCODE = '23505';
  END IF;

  v_base := btrim(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), '-');
  IF v_base = '' THEN v_base := 'company'; END IF;
  v_base := btrim(left(v_base, 50), '-');
  v_slug := v_base;
  WHILE EXISTS (SELECT 1 FROM public.companies c WHERE c.slug = v_slug) LOOP
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  END LOOP;

  INSERT INTO public.companies (id, slug, name, alert_email, regrid_lookup_quota)
  VALUES (v_id, v_slug, btrim(p_name), NULLIF(p_email, ''), 50);
  INSERT INTO public.company_members (cognito_sub, company_id) VALUES (p_sub, v_id);
  INSERT INTO public.service_regions (company_id, kind, value, tier_group)
  SELECT DISTINCT v_id, 'county', t.county, 'standard' FROM public.tax_rates t WHERE t.state = 'PA';
  RETURN v_id;
END
$$;

-- For the Lambdas' role only; app_public cannot sign anyone up.
GRANT EXECUTE ON FUNCTION create_company_for_sub(text, text, text) TO app_rw;
GRANT CREATE ON SCHEMA public TO app_definer;
ALTER FUNCTION create_company_for_sub(text, text, text) OWNER TO app_definer;
REVOKE CREATE ON SCHEMA public FROM app_definer;
