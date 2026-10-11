// Cloudflare Turnstile verification, done before any Regrid call or lead insert.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * `failed`: Cloudflare says the token is bad; the request is refused.
 * `unavailable`: Cloudflare could not be reached or had an error of its own.
 * The widget stays usable then (design section 10), but nothing that costs
 * money runs: no Regrid lookup.
 */
export type TurnstileResult = "ok" | "failed" | "unavailable";

export type TurnstileVerify = (token: string, remoteIp: string | null) => Promise<TurnstileResult>;

export function createTurnstile(options: {
  secret: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): TurnstileVerify {
  const { secret, fetch: doFetch = fetch, timeoutMs = 3000 } = options;
  return async (token, remoteIp) => {
    const form = new URLSearchParams({ secret, response: token });
    if (remoteIp) form.set("remoteip", remoteIp);
    try {
      const res = await doFetch(SITEVERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return "unavailable";
      const body = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
      if (body.success === true) return "ok";
      return body["error-codes"]?.includes("internal-error") ? "unavailable" : "failed";
    } catch {
      return "unavailable";
    }
  };
}
