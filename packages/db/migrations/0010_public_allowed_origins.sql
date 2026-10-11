-- The widget page is served with a frame-ancestors header listing the origins
-- that may embed the company's widget, so the public profile route needs
-- companies.allowed_origins. The list is public by nature (the header sends
-- it to every visitor); nothing else of the company row comes with it.

-- NULL when no company has the slug.
CREATE FUNCTION company_allowed_origins(p_slug text) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  RETURN (SELECT c.allowed_origins FROM public.companies c WHERE c.slug = p_slug);

-- Grant before the hand-over to app_definer (EXECUTE is not PUBLIC by default).
GRANT EXECUTE ON FUNCTION company_allowed_origins(text) TO app_public;
GRANT CREATE ON SCHEMA public TO app_definer;
ALTER FUNCTION company_allowed_origins(text) OWNER TO app_definer;
REVOKE CREATE ON SCHEMA public FROM app_definer;
