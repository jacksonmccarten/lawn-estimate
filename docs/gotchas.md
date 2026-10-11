---
tags: [gotchas]
---

# Gotchas

All found while building the schema and RLS in `packages/db`. The design is in [[ENGINEERING_DESIGN]].

> [!warning] A superuser ignores RLS, so never check tenancy as `postgres`
> The container's `postgres` user sees every company's rows whatever
> `app.company_id` says. Migrations and tests connect as `app_owner`, which is
> not a superuser and is bound by `FORCE` like Aurora's master user. Even
> `app_owner` sees zero rows until it sets `app.company_id`.

> [!warning] `FORCE ROW LEVEL SECURITY` also binds the owner's own definer objects
> A view or `SECURITY DEFINER` function owned by the table owner runs under the
> tenant policies and returns zero rows when no company is set. Anything that
> must read across companies is owned by `app_definer`, which has its own
> `SELECT` policies and column-level grants.

> [!warning] Grant before you hand an object to `app_definer`
> After `ALTER ... OWNER TO app_definer` the migration user no longer owns the
> object, and on Aurora (where it is not a superuser) cannot grant on it. A
> local superuser hides this; it only fails in a deployed environment.

> [!warning] `app.company_id` reads back as `''`, not NULL, after a transaction
> Once a connection has set it with `SET LOCAL`, later transactions on that
> connection see an empty string. Policies go through `current_company_id()`,
> which turns that into NULL (no rows). Casting the setting to `uuid` directly
> raises instead.

> [!warning] An update or delete blocked by RLS changes zero rows; it does not raise
> Inserts do raise (`42501`). Code that updates another table must check the
> row count. Published pricing is the exception: triggers raise `55000`, and
> for that to work the pricing UPDATE and DELETE policies must not filter on
> `published_at`. Adding that filter back would make those writes silent again.

> [!warning] A new function is callable by nobody until it is granted
> `0005_public_entry.sql` revokes the default `EXECUTE` grant to `PUBLIC`. Every
> new function needs an explicit `GRANT EXECUTE` to the roles that call it,
> including `app_rw` and `app_definer` for anything a policy uses. Grant before
> handing the function to `app_definer`.

> [!warning] A zip's primary county can carry the wrong tax rate
> `county_for_zip` names one county per zip, the one with the most land area.
> 30 Pennsylvania zips straddle a 6% county and Allegheny (7%) or Philadelphia
> (8%), for example 15085, 16046 and 19128. On the manual path, call
> `counties_for_zip` and, if the rates differ, answer `county_required` instead
> of pricing at the primary county. Use a zip only when there is no parcel
> county.

> [!warning] `LQ001` from `leads` means "already decided", not a failure
> The trigger raises it when a decided lead is decided again. The decision
> handler must turn it into 409 `lead_already_decided`, not a 500.

> [!warning] Not every zip is in `zip_county`
> The Census file covers ZCTAs. Some real zips, mostly PO-box-only ones, have
> no ZCTA, so `county_for_zip` returns NULL for them. NULL means "ask the
> homeowner to call", never a default rate.

> [!warning] Roles are cluster-wide, privileges are per database
> `0001_roles.sql` guards role creation for that reason. The RLS suite resets
> the `app_rw` and `app_public` passwords on whatever cluster it runs against
> and refuses any host but localhost.

> [!warning] Migrations are append-only
> The runner records file names in `schema_migrations` and skips them, so an
> edit to an existing file never reaches a database that already ran it. Change
> behavior with a new numbered file.

> [!warning] The schema needs the `btree_gist` extension
> The no-overlap constraint on `pricing_tiers` uses it. It installed without
> superuser rights on stock PostgreSQL 16, but it has not been tried on Aurora.
> Confirm it is available on the chosen Aurora engine version before
> provisioning; without it `0002_schema.sql` fails.

> [!warning] CI cannot mount `docker/initdb` into its Postgres service
> A GitHub Actions service container starts before the checkout. The workflow
> runs the same SQL file with `psql` instead; keep the two in step.

> [!warning] `docker/initdb` runs only when the data volume is created
> Changing it has no effect on an existing container; `docker compose down -v`
> first.
