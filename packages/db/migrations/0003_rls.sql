-- Row Level Security, grants, and the two cross-company objects.

-- The tenant for this transaction, set by withCompany() with
--   SELECT set_config('app.company_id', $1, true)
-- NULL when unset. NULLIF matters: once a pooled connection has run SET LOCAL,
-- the setting reads back as '' in later transactions, and ''::uuid would raise
-- instead of matching no rows.
CREATE FUNCTION current_company_id() RETURNS uuid
  LANGUAGE sql STABLE
  RETURN NULLIF(current_setting('app.company_id', true), '')::uuid;

-- Every company-scoped table: ENABLE + FORCE (the owner bypasses RLS without
-- FORCE). Policies name no role, so they bind every role including the owner.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'companies', 'company_members', 'service_regions', 'pricing_versions',
    'services', 'pricing_tiers', 'quotes', 'leads', 'usage_meters', 'admin_access_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;

  -- Plain tenant isolation, all commands.
  FOREACH t IN ARRAY ARRAY[
    'company_members', 'service_regions', 'quotes', 'leads', 'usage_meters', 'admin_access_log'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (company_id = current_company_id()) '
      'WITH CHECK (company_id = current_company_id())',
      t || '_company', t);
  END LOOP;
END
$$;

CREATE POLICY companies_company ON companies
  USING (id = current_company_id())
  WITH CHECK (id = current_company_id());

-- Pricing: readable and writable by the company. Immutability after publish
-- is the triggers' job (0002): the UPDATE and DELETE policies must let a
-- published row through to them, or the write would silently match nothing.
-- The draft checks on new rows stay as a second layer.
CREATE POLICY pricing_versions_select ON pricing_versions FOR SELECT
  USING (company_id = current_company_id());
CREATE POLICY pricing_versions_insert ON pricing_versions FOR INSERT
  WITH CHECK (company_id = current_company_id() AND published_at IS NULL);
CREATE POLICY pricing_versions_update ON pricing_versions FOR UPDATE
  USING (company_id = current_company_id())
  WITH CHECK (company_id = current_company_id());

DO $$
DECLARE
  t text;
  mine text := 'company_id = current_company_id()';
  draft text := 'company_id = current_company_id() AND EXISTS ('
    'SELECT 1 FROM pricing_versions v WHERE v.id = version_id AND v.published_at IS NULL)';
BEGIN
  FOREACH t IN ARRAY ARRAY['services', 'pricing_tiers'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', t || '_select', t, mine);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s)', t || '_insert', t, draft);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',
      t || '_update', t, mine, draft);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s)', t || '_delete', t, mine);
  END LOOP;
END
$$;

-- app_rw: the Lambdas. Table privileges are the outer bound; RLS narrows them
-- to one company per transaction.
GRANT SELECT, INSERT, UPDATE ON companies, pricing_versions, quotes, leads, usage_meters TO app_rw;
GRANT SELECT, INSERT, DELETE ON company_members TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_regions, services, pricing_tiers, parcel_cache TO app_rw;
GRANT SELECT ON tax_rates, service_catalog TO app_rw;
-- Append-only for the application: no SELECT, UPDATE or DELETE.
GRANT INSERT ON admin_access_log TO app_rw;

-- app_definer: cross-company reads, limited to the columns its objects use.
GRANT SELECT (id, slug, name, theme) ON companies TO app_definer;
GRANT SELECT (cognito_sub, company_id) ON company_members TO app_definer;
GRANT SELECT (id, company_id, version, published_at) ON pricing_versions TO app_definer;
GRANT SELECT (version_id, code, name, season) ON services TO app_definer;
GRANT SELECT (company_id, kind, value) ON service_regions TO app_definer;

CREATE POLICY companies_definer ON companies FOR SELECT TO app_definer USING (true);
CREATE POLICY company_members_definer ON company_members FOR SELECT TO app_definer USING (true);
CREATE POLICY pricing_versions_definer ON pricing_versions FOR SELECT TO app_definer USING (true);
CREATE POLICY services_definer ON services FOR SELECT TO app_definer USING (true);
CREATE POLICY service_regions_definer ON service_regions FOR SELECT TO app_definer USING (true);

-- What an anonymous visitor may know about a company: name, theme, the
-- services of its latest published version, its regions. No rate, tier,
-- tier group or taxable flag. Owned by app_definer, so it reads through that
-- role's policies rather than the caller's.
CREATE VIEW public_company_profile AS
SELECT
  c.id AS company_id,
  c.slug,
  c.name,
  c.theme,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name, 'season', s.season) ORDER BY s.name)
    FROM services s
    WHERE s.version_id = cv.id
  ), '[]'::jsonb) AS services,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object('kind', r.kind, 'value', r.value) ORDER BY r.kind, r.value)
    FROM service_regions r
    WHERE r.company_id = c.id
  ), '[]'::jsonb) AS regions
FROM companies c
LEFT JOIN LATERAL (
  SELECT v.id
  FROM pricing_versions v
  WHERE v.company_id = c.id AND v.published_at IS NOT NULL
  ORDER BY v.version DESC
  LIMIT 1
) cv ON true;

-- Membership lookup for withCompany(): the company for a verified Cognito sub.
-- It has to cross RLS, because the company is not known until it returns.
CREATE FUNCTION company_id_for_sub(p_sub text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  RETURN (SELECT m.company_id FROM public.company_members m WHERE m.cognito_sub = p_sub);

-- Grants come before the hand-over: afterwards the migration user no longer
-- owns these objects and (not being a superuser on Aurora) could not grant.
REVOKE ALL ON FUNCTION company_id_for_sub(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION company_id_for_sub(text) TO app_rw;
GRANT SELECT ON public_company_profile TO app_public, app_rw;

-- Changing owner needs CREATE on the schema for the new owner; revoke it after.
GRANT CREATE ON SCHEMA public TO app_definer;
ALTER VIEW public_company_profile OWNER TO app_definer;
ALTER FUNCTION company_id_for_sub(text) OWNER TO app_definer;
REVOKE CREATE ON SCHEMA public FROM app_definer;
