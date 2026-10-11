// POST /submit (design sections 5 and 9): the quote token plus contact
// details become a lead, and the company is alerted.

import { randomUUID } from "node:crypto";
import { SubmitRequest, SubmitResponse } from "@lq/api-contract";
import { HttpError, json, parseBody, respond, validate, type HttpEvent, type HttpResult } from "../http.js";
import * as db from "./db.js";
import { embedOriginRefused, requireWidgetOrigin, type PublicDeps } from "./deps.js";
import { throughEdge } from "./edge.js";

/** The honeypot field holds something: a bot. Exported for the tests. */
export function isHoneypotHit(body: unknown): boolean {
  const website = (body as { website?: unknown } | null)?.website;
  return typeof website === "string" && website.length > 0;
}

export function createSubmitHandler(deps: PublicDeps) {
  return (event: HttpEvent): Promise<HttpResult> =>
    respond(async () => {
      const { ip } = throughEdge(deps.edge, event, deps.log);
      requireWidgetOrigin(deps, event);
      const body = parseBody(event);
      if (isHoneypotHit(body)) {
        // Answer as if it worked, so the bot learns nothing, and store nothing.
        deps.log("warn", "honeypot");
        return json(200, SubmitResponse.parse({ status: "submitted", quoteId: randomUUID() }));
      }
      const req = validate(SubmitRequest, body);
      const claims = deps.tokens.verify(req.token);

      // An outage at Cloudflare does not cost the company a lead (design
      // section 10): the signed token, the honeypot, the dedupe and the SMS
      // cap still stand. A token Cloudflare rejects is refused.
      const verdict = await deps.turnstile(req.turnstile, ip);
      if (verdict === "failed") throw new HttpError("turnstile_failed", "the Turnstile check failed");
      if (verdict === "unavailable") deps.log("warn", "turnstile_unavailable", { route: "submit" });

      const result = await deps.withPublic(claims.company, (tx) =>
        db.submitLead(tx, claims.company, claims.quoteId, req.embedOrigin, req.contact),
      );
      if (result.result === "origin_not_allowed") throw embedOriginRefused(deps, claims.company);
      if (result.result === "not_found") throw new HttpError("token_expired", "the quote no longer exists");

      if (result.result === "created") {
        deps.log("info", "lead_created", { quoteId: claims.quoteId, leadId: result.lead_id, notify: result.notify });
        // After the commit: a failed alert must not undo the lead.
        if (result.notify) {
          const sent = await deps.notifier.leadCreated(
            {
              companyName: result.company_name,
              leadId: result.lead_id,
              contact: req.contact,
              addressText: result.address_text,
              county: result.county,
              grassSqft: result.grass_sqft,
              lines: result.line_items,
              taxCents: result.tax_cents,
              totalCents: result.total_cents,
            },
            { email: result.alert_email, phone: result.alert_phone, smsAllowed: result.sms_ok },
          );
          if (sent.email || sent.sms) {
            await deps.withPublic(claims.company, (tx) => db.markNotified(tx, claims.company, result.lead_id, sent.sms));
          }
        }
      }
      // A repeat of a submit that already went through gets the same answer.
      return json(200, SubmitResponse.parse({ status: "submitted", quoteId: claims.quoteId }));
    });
}
