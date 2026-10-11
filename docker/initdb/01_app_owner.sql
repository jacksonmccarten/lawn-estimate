-- Runs once, as the container's superuser, when the data volume is created.
-- Everything else (migrations, tests) connects as app_owner. It is not a
-- superuser, so FORCE ROW LEVEL SECURITY binds it exactly as it binds the
-- Aurora master user; a superuser would hide ownership and RLS mistakes.
CREATE ROLE app_owner LOGIN CREATEDB CREATEROLE PASSWORD 'app_owner';
CREATE DATABASE lawnquote OWNER app_owner;
