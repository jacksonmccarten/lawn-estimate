-- Narrows app_public to what withPublic() needs: SELECT on the
-- public_company_profile view and EXECUTE on SECURITY DEFINER functions that
-- are granted to it by name (the estimate and submit functions, step 4).

-- PostgreSQL grants EXECUTE on every new function to PUBLIC. Take that away
-- for the functions that exist, and for every function this role creates from
-- now on, so a function is callable only by the roles it is granted to.
REVOKE EXECUTE ON FUNCTION current_company_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pricing_versions_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pricing_children_immutable() FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The tenant policies call current_company_id() as whichever role is querying.
GRANT EXECUTE ON FUNCTION current_company_id() TO app_rw, app_definer;
