-- Application roles. Roles are cluster-wide, so creation is guarded.
-- None of them is a superuser, has BYPASSRLS, or owns a table: the migration
-- user owns the tables, and FORCE ROW LEVEL SECURITY binds even that owner.
-- Roles are created NOLOGIN; each environment enables login and sets the
-- password out of band (Secrets Manager), never in a migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    -- Used by the Lambdas. Every statement runs inside withCompany().
    CREATE ROLE app_rw NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_public') THEN
    -- Anonymous routes. Sees public_company_profile and nothing else.
    CREATE ROLE app_public NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_definer') THEN
    -- Never logs in. Owns the few objects that must read across companies
    -- (the public profile view, membership resolution), with column-level
    -- grants and its own SELECT policies.
    CREATE ROLE app_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Lets the migration user hand objects to app_definer without inheriting its
-- cross-company read policies.
GRANT app_definer TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
