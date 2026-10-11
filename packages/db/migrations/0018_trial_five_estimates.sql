-- The free trial is now 5 estimates a month, down from 50: enough to see a
-- quote come out of the widget, and a reason to choose a plan.
--
-- create_company_for_sub is the same function as in 0012 with the allowance
-- changed. It belongs to app_definer, so it is replaced as that role.

GRANT CREATE ON SCHEMA public TO app_definer;
SET LOCAL ROLE app_definer;

CREATE OR REPLACE FUNCTION create_company_for_sub(p_sub text, p_name text, p_email text) RETURNS uuid
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
  VALUES (v_id, v_slug, btrim(p_name), NULLIF(p_email, ''), 5);
  INSERT INTO public.company_members (cognito_sub, company_id) VALUES (p_sub, v_id);
  INSERT INTO public.service_regions (company_id, kind, value, tier_group)
  SELECT DISTINCT v_id, 'county', t.county, 'standard' FROM public.tax_rates t WHERE t.state = 'PA';
  RETURN v_id;
END
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM app_definer;

-- Companies already on the old trial allowance move to the new one. Only a
-- row still at exactly 50 is a trial: the demonstration company and any
-- allowance set by hand are left alone. FORCE ROW LEVEL SECURITY binds the
-- owner too, so the owner is let through for this one statement.
CREATE POLICY companies_trial_allowance_migration ON companies FOR ALL TO app_owner USING (true) WITH CHECK (true);
UPDATE companies SET regrid_lookup_quota = 5 WHERE regrid_lookup_quota = 50;
DROP POLICY companies_trial_allowance_migration ON companies;
