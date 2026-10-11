// The signed quote token: /estimate returns it, /submit and the adjust call
// send it back. It names a quote and its company and nothing else; the price
// lives in the quote row, so the price shown is the price submitted.

import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http.js";

/** A priced quote is deleted after 7 days if never submitted; its token lasts as long. */
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export type QuoteClaims = { quoteId: string; company: string };

export type TokenCodec = {
  sign(claims: QuoteClaims): string;
  /** Throws HttpError token_invalid or token_expired. */
  verify(token: string): QuoteClaims;
};

type Payload = { v: 1; q: string; c: string; exp: number };

export function createTokenCodec(secret: string, now: () => Date = () => new Date()): TokenCodec {
  if (secret.length < 32) throw new Error("the quote token secret must be at least 32 characters");
  const mac = (body: string) => createHmac("sha256", secret).update(body).digest();
  const invalid = () => new HttpError("token_invalid", "the quote token is not valid");

  return {
    sign({ quoteId, company }) {
      const payload: Payload = { v: 1, q: quoteId, c: company, exp: Math.floor(now().getTime() / 1000) + TOKEN_TTL_SECONDS };
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${body}.${mac(body).toString("base64url")}`;
    },
    verify(token) {
      const [body, signature, ...rest] = token.split(".");
      if (!body || !signature || rest.length) throw invalid();
      const given = Buffer.from(signature, "base64url");
      const expected = mac(body);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();
      // Signed by us, so the shape is ours; the version check guards a future format.
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
      if (payload.v !== 1) throw invalid();
      if (payload.exp * 1000 <= now().getTime()) throw new HttpError("token_expired", "the quote token has expired");
      return { quoteId: payload.q, company: payload.c };
    },
  };
}
