// The local loop's stand-in for CloudFront, API Gateway and the Cognito
// authorizer: one HTTP server on this machine that runs the real handlers
// against the local database. Never deployed.
//
// What is real: the handlers, withPublic and withCompany with their own
// roles, pricing, Turnstile verification and (with REGRID_TOKEN) Regrid.
// What is not: sign-in (the dashboard's mock token is trusted unsigned) and
// lead alerts (composed, then noted here instead of sent).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { routes } from "@lq/api-contract";
import { createWithCompany, createWithPublic, createWithSignup, PgDbClient } from "@lq/db";
import pg from "pg";
import { createCompanyApi } from "../src/company/api.js";
import type { HttpEvent, HttpResult } from "../src/http.js";
import { log } from "../src/log.js";
import type { PublicDeps } from "../src/public/deps.js";
import { createEstimateHandler } from "../src/public/estimate.js";
import { createNotifier } from "../src/public/notify.js";
import { createProfileHandler } from "../src/public/profile.js";
import { createRegridLookup } from "../src/public/regrid.js";
import { createSubmitHandler } from "../src/public/submit.js";
import { createTokenCodec } from "../src/public/token.js";
import { createTurnstile } from "../src/public/turnstile.js";
import { env, requireLocal } from "./env.js";

requireLocal(env.publicUrl, env.rwUrl);

const withPublic = createWithPublic(new PgDbClient(new pg.Pool({ connectionString: env.publicUrl, max: 4 })));
const rw = new PgDbClient(new pg.Pool({ connectionString: env.rwUrl, max: 4 }));
const withCompany = createWithCompany(rw);

const publicDeps: PublicDeps = {
  withPublic,
  turnstile: createTurnstile({ secret: env.turnstileSecret }),
  regrid: env.regridToken
    ? createRegridLookup({ token: env.regridToken, ...(env.regridBaseUrl ? { baseUrl: env.regridBaseUrl } : {}) })
    : null,
  tokens: createTokenCodec(env.quoteTokenSecret),
  notifier: createNotifier({
    // The message holds the homeowner's details, so only its last line (the lead's link) is shown.
    sendEmail: async ({ text }) => console.log(`[local] lead alert email composed, not sent. ${text.split("\n").at(-1)}`),
    sendSms: async () => {},
    smsEnabled: false,
    dashboardUrl: env.dashboardOrigin,
    log,
  }),
  ipHashSalt: env.ipHashSalt,
  widgetOrigin: env.widgetOrigin,
  log,
};

const estimate = createEstimateHandler(publicDeps);
const submit = createSubmitHandler(publicDeps);
const profile = createProfileHandler({ withPublic });
const companyApi = createCompanyApi({ withCompany, signUp: createWithSignup(rw) });

type Handler = (event: HttpEvent) => Promise<HttpResult>;
type Match = { handler: Handler; routeKey: string; params: Record<string, string>; owner: boolean };

const publicHandlers: Record<string, Handler> = { "/estimate": estimate, "/submit": submit, "/profile/{company}": profile };

/** The contract's routes are the routing table, as they are for API Gateway. */
function match(method: string, path: string): Match | null {
  for (const route of Object.values(routes)) {
    if (route.method !== method) continue;
    const names: string[] = [];
    const pattern = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      names.push(name);
      return "([^/]+)";
    });
    const found = new RegExp(`^${pattern}$`).exec(path);
    if (!found) continue;
    const params = Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(found[i + 1]!)]));
    const handler = route.auth === "public" ? publicHandlers[route.path] : companyApi;
    if (!handler) return null;
    return { handler, routeKey: `${route.method} ${route.path}`, params, owner: route.auth === "owner" };
  }
  return null;
}

/**
 * In place of the JWT authorizer: the dashboard's mock sign-in token, which
 * is the claims of a Cognito ID token with no signature. Groups are passed
 * the way an HTTP API flattens them ("[owner]").
 */
function mockClaims(authorization: string | undefined): Record<string, string> | null {
  const prefix = "Bearer mock.";
  if (!authorization?.startsWith(prefix)) return null;
  try {
    const claims = JSON.parse(Buffer.from(authorization.slice(prefix.length), "base64").toString("utf8")) as {
      sub?: unknown;
      email?: unknown;
      exp?: unknown;
      "cognito:groups"?: unknown;
    };
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null;
    const groups = Array.isArray(claims["cognito:groups"]) ? claims["cognito:groups"].map(String) : [];
    // The mock has no unverified addresses.
    return {
      sub: claims.sub,
      "cognito:groups": `[${groups.join(" ")}]`,
      ...(typeof claims.email === "string" ? { email: claims.email, email_verified: "true" } : {}),
    };
  } catch {
    return null;
  }
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined;
}

function send(res: ServerResponse, cors: Record<string, string>, result: HttpResult): void {
  res.writeHead(result.statusCode ?? 200, { ...(result.headers as Record<string, string> | undefined), ...cors });
  res.end(result.body ?? "");
}

const failure = (status: number, code: string, message: string): HttpResult => ({
  statusCode: status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify({ error: { code, message } }),
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  // The two front ends are the only browsers this API answers.
  const origin = req.headers.origin;
  const cors: Record<string, string> =
    origin === env.widgetOrigin || origin === env.dashboardOrigin
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, PUT, PATCH, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, x-act-as-company",
          "access-control-max-age": "600",
          vary: "Origin",
        }
      : {};

  try {
    if (method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const found = match(method, url.pathname);
    if (!found) return send(res, cors, failure(404, "not_found", "no such route"));

    const claims = found.owner ? mockClaims(req.headers.authorization) : null;
    if (found.owner && !claims) return send(res, cors, failure(401, "unauthenticated", "sign in to use this route"));

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers[name] = value;
    const event = {
      routeKey: found.routeKey,
      rawPath: url.pathname,
      headers,
      body: method === "GET" ? undefined : await readBody(req),
      isBase64Encoded: false,
      pathParameters: found.params,
      queryStringParameters: url.search ? Object.fromEntries(url.searchParams) : undefined,
      requestContext: {
        http: { method, path: url.pathname, sourceIp: req.socket.remoteAddress ?? "127.0.0.1" },
        ...(claims ? { authorizer: { jwt: { claims } } } : {}),
      },
    } as unknown as HttpEvent;

    const result = await found.handler(event);
    console.log(`[local] ${method} ${url.pathname} ${result.statusCode ?? 200}`);
    send(res, cors, result);
  } catch (err) {
    console.error(`[local] ${method} ${url.pathname} failed: ${(err as Error).name}`);
    send(res, cors, failure(500, "internal", "something went wrong"));
  }
});

// Loopback only: this server trusts an unsigned sign-in.
server.listen(env.port, "127.0.0.1", () => {
  console.log(`[local] API on http://localhost:${env.port} (widget ${env.widgetOrigin}, dashboard ${env.dashboardOrigin})`);
  console.log(
    env.regridToken
      ? "[local] Regrid lookups are on: each address not yet cached is a metered call"
      : "[local] REGRID_TOKEN is not set: every address goes to the manual path",
  );
});
