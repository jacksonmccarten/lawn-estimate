---
tags: [structure]
path: /
---

# Repository root

The root is an npm workspaces monorepo. Nothing at the root is application code; it is the glue that lets seven workspaces install, build, test and deploy together. Back to [[Project Structure]].

## Files

| File | What it is |
| --- | --- |
| `package.json` | Package `instant-lawn-quote`. Declares the workspaces (`apps/*`, `packages/*`, `services/*`, `infra`) and the root scripts below. Node 20 or newer; TypeScript is the only root dependency. |
| `package-lock.json` | One lockfile for every workspace. |
| `tsconfig.base.json` | Shared compiler options: ES2022, `NodeNext` modules, `strict`, `noUncheckedIndexedAccess`, `esModuleInterop`, `noEmit`. Each workspace's `tsconfig.json` extends it. |
| `docker-compose.yml` | Local PostgreSQL 16 on port 54320 for migrations and tests, with `docker/initdb` mounted. Never used in a deployed environment. |
| `docker/initdb/01_app_owner.sql` | Runs once, as the container's superuser, when the data volume is created: makes `app_owner` (a non-superuser, as on Aurora) and the `lawnquote` database it owns. Everything else connects as `app_owner`, so `FORCE ROW LEVEL SECURITY` binds it locally as it does the Aurora master user. |
| `.env.example` | `DATABASE_URL`, the owner connection for migrations and the RLS tests. |
| `amplify.yml` | Amplify Hosting builds for both front ends: `nvm use 22`, `npm ci` at the root, `next build` in each app, `node_modules` cached. The widget's build copies `LQ_*` and the Mapbox token into `.env.production`, because the widget reads them on the server at request time and Amplify only passes variables to the SSR runtime that way. |
| `.github/workflows/ci.yml` | See [[Testing and CI]]. |
| `CLAUDE.md` | Project instructions for coding agents: the non-negotiables, the stack, the conventions, the build order and the commands. A condensed version of [[ENGINEERING_DESIGN]]. |
| `.claude/settings.json` | Agent settings: the Playwright and impeccable plugins, an allowlist of read-only git commands, and a deny list that keeps `.env`, `.env.local`, `*.pem` and `*.key` unread. |
| `.worktreeinclude` | Gitignored files copied into each new worktree (`.env.local`). |
| `.gitignore` | Env files except `.env.example`, secret material, `node_modules`, Obsidian per-machine state (`.obsidian/workspace*.json`; the vault config itself is committed), local agent tooling. |
| `docs/` | This vault. [[README]] is its map. |

## Root scripts

All run from the root.

| Script | Does |
| --- | --- |
| `npm run db:up` / `db:down` | Start or stop the local Postgres container (`docker compose up -d --wait`). |
| `npm run db:migrate` | Apply `packages/db/migrations` to `DATABASE_URL`. |
| `npm run db:seed` | Enable the two application roles locally and create the demonstration company, Nittany Lawn Care (`nittany-lawn`). |
| `npm run dev:api` | The local API on port 8787 (`services/lambdas/dev/server.ts`). |
| `npm run dev:widget` | The widget app on port 3001. |
| `npm run dev:dashboard` | The dashboard on port 3000. |
| `npm test` | Every workspace's tests, including the wrong-tenant RLS suite (needs `db:up`). |
| `npm run typecheck` | Every workspace's `tsc`. |

The local loop that runs the widget, the API and the dashboard together is in [[local-loop]].

## Workspace naming

Every workspace is a private `@lq/*` package (`lq` for "lawn quote", the project's first name). The product is InstaQuotesAI; the internal names stayed because renaming packages, stacks and database roles would replace deployed resources (see "Product name" in the [[ENGINEERING_DESIGN#15. Decisions and open questions|Decisions table]]).

Workspaces depend on each other by package name, and the shared packages export TypeScript source directly (`"exports": { ".": "./src/index.ts" }`). Their relative imports are spelled `./x.js` for `./x.ts` (NodeNext), which Turbopack cannot resolve: that is why both Next.js apps build with `--webpack` and list the packages in `transpilePackages`.
