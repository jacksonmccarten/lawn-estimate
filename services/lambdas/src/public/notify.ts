// Lead alerts to the company: an email through SES, and an SMS through SNS
// behind a flag that stays off until 10DLC registration clears.
//
// The email goes to the company that owns the lead, so it carries the
// homeowner's contact details. The SMS carries none. Neither is ever logged.

import type { QuoteLine } from "@lq/api-contract";

export type LeadAlert = {
  companyName: string;
  leadId: string;
  contact: { name: string; phone?: string | undefined; email?: string | undefined };
  addressText: string;
  county: string;
  grassSqft: number;
  lines: QuoteLine[];
  taxCents: number;
  totalCents: number;
};

export type EmailMessage = { to: string; subject: string; text: string };
export type SmsMessage = { to: string; text: string };

/** Where an alert may go, as stored on the company and capped by submit_lead. */
export type AlertTargets = { email: string | null; phone: string | null; smsAllowed: boolean };

export type Notifier = {
  /** Sends what it can and reports what went out. Never throws: the lead is already saved. */
  leadCreated(alert: LeadAlert, targets: AlertTargets): Promise<{ email: boolean; sms: boolean }>;
};

// Format only at the edge: money is integer cents everywhere else.
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function renderLeadEmail(alert: LeadAlert, dashboardUrl: string): Omit<EmailMessage, "to"> {
  const { contact } = alert;
  const text = [
    `${contact.name} requested service from ${alert.companyName}.`,
    "",
    ...(contact.phone ? [`Phone: ${contact.phone}`] : []),
    ...(contact.email ? [`Email: ${contact.email}`] : []),
    `Address: ${alert.addressText} (${alert.county} County)`,
    `Estimated lawn area: ${alert.grassSqft.toLocaleString("en-US")} sq ft`,
    "",
    ...alert.lines.map((l) => `${l.name}: ${dollars(l.amountCents)}${l.taxable ? "" : " (not taxable)"}`),
    `Sales tax: ${dollars(alert.taxCents)}`,
    `Estimated total: ${dollars(alert.totalCents)}`,
    "",
    "This is an estimate the homeowner saw, not an accepted job.",
    `Accept, adjust or decline it: ${dashboardUrl}/leads/${alert.leadId}`,
  ].join("\n");
  return { subject: `New quote request: ${dollars(alert.totalCents)} estimate`, text };
}

export function renderLeadSms(alert: LeadAlert, dashboardUrl: string): string {
  return `${alert.companyName}: new quote request, ${dollars(alert.totalCents)} estimate. ${dashboardUrl}/leads/${alert.leadId}`;
}

export function createNotifier(options: {
  sendEmail: (message: EmailMessage) => Promise<void>;
  sendSms: (message: SmsMessage) => Promise<void>;
  /** SMS_ALERTS_ENABLED. Off: email only. */
  smsEnabled: boolean;
  dashboardUrl: string;
  log: (level: "error", event: string, fields: { leadId: string; channel: string }) => void;
}): Notifier {
  const { sendEmail, sendSms, smsEnabled, dashboardUrl, log } = options;
  const attempt = async (channel: string, leadId: string, send: () => Promise<void>): Promise<boolean> => {
    try {
      await send();
      return true;
    } catch {
      log("error", "lead_alert_failed", { leadId, channel });
      return false;
    }
  };

  return {
    async leadCreated(alert, targets) {
      const [email, sms] = await Promise.all([
        targets.email !== null
          ? attempt("email", alert.leadId, () => sendEmail({ to: targets.email!, ...renderLeadEmail(alert, dashboardUrl) }))
          : false,
        smsEnabled && targets.smsAllowed && targets.phone !== null
          ? attempt("sms", alert.leadId, () => sendSms({ to: targets.phone!, text: renderLeadSms(alert, dashboardUrl) }))
          : false,
      ]);
      return { email, sms };
    },
  };
}
