// POST /contact: the public website's contact form. The message is emailed
// to the InstaQuoter AI team through SES and not stored. With no inbox
// configured, or when the email cannot be sent, the answer is 503
// contact_unavailable, so the form never claims a message went out when it
// did not. The visitor's details are never logged.

import { ContactRequest, ContactResponse } from "@lq/api-contract";
import { HttpError, json, parseBody, respond, validate, type HttpEvent, type HttpResult } from "../http.js";
import type { Log } from "../log.js";
import { sourceIp } from "./deps.js";
import type { EmailMessage } from "./notify.js";
import { isHoneypotHit } from "./submit.js";
import type { TurnstileVerify } from "./turnstile.js";

export type ContactDeps = {
  turnstile: TurnstileVerify;
  /** Null when CONTACT_TO is not set: the form answers contact_unavailable. */
  inbox: { to: string; send: (message: EmailMessage) => Promise<void> } | null;
  /** The website's own origin (the dashboard app). When set, calls from anywhere else are refused. */
  siteOrigin: string | null;
  log: Log;
};

export function renderContactEmail(req: Pick<ContactRequest, "name" | "email" | "message">): Omit<EmailMessage, "to"> {
  return {
    subject: `Website contact form: ${req.name}`,
    text: [`From: ${req.name} <${req.email}>`, "", req.message, "", "Sent from the contact form on the InstaQuoter AI website."].join("\n"),
  };
}

export function createContactHandler(deps: ContactDeps) {
  return (event: HttpEvent): Promise<HttpResult> =>
    respond(async () => {
      if (deps.siteOrigin !== null && event.headers?.origin !== deps.siteOrigin) {
        deps.log("warn", "origin_refused", { check: "site" });
        throw new HttpError("origin_not_allowed", "this origin may not call the contact form");
      }
      const body = parseBody(event);
      if (isHoneypotHit(body)) {
        // As for /submit: the bot learns nothing, and nothing is sent.
        deps.log("warn", "honeypot", { route: "contact" });
        return json(200, ContactResponse.parse({ status: "sent" }));
      }
      const req = validate(ContactRequest, body);
      if (!deps.inbox) {
        deps.log("warn", "contact_not_configured");
        throw new HttpError("contact_unavailable", "the contact form has no inbox configured");
      }
      const verdict = await deps.turnstile(req.turnstile, sourceIp(event));
      if (verdict === "failed") throw new HttpError("turnstile_failed", "the Turnstile check failed");
      if (verdict === "unavailable") deps.log("warn", "turnstile_unavailable", { route: "contact" });

      try {
        await deps.inbox.send({ to: deps.inbox.to, ...renderContactEmail(req) });
      } catch {
        deps.log("error", "contact_send_failed");
        throw new HttpError("contact_unavailable", "the message could not be sent");
      }
      deps.log("info", "contact_sent");
      return json(200, ContactResponse.parse({ status: "sent" }));
    });
}
