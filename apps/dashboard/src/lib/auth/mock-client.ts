// Local stand-in for Cognito: one seeded owner, any password, fixed codes.
// It mirrors the real flow's shape (short-lived tokens that are refreshed,
// sign-up with an emailed code) so the screens and timers are the real ones.
//
// The seeded owner signs in with a second step, the way an account with an
// authenticator does. Accounts made on the sign-up screen do not, the way a
// new real account does not. They last until the page is reloaded.

import { AuthError, type AuthClient, type Session } from "./types";
import { encodeMockToken } from "./mock-token";

export const MOCK_EMAIL = "owner@nittanylawn.example";
export const MOCK_TOTP = "123456";
/** The code "emailed" to every sign-up. */
export const MOCK_SIGNUP_CODE = "123456";
export const MOCK_SESSION_SECONDS = 30 * 60;
// Matches MOCK_OWNER_SUB in src/mock/store.ts, the mock's company_members row.
const MOCK_SUB = "mock-sub-owner-0001";

/** Sign-ups in this tab: email to whether its code has been entered. */
const signups = new Map<string, { confirmed: boolean }>();

const subFor = (email: string) => (email === MOCK_EMAIL ? MOCK_SUB : `mock-sub-${email}`);
const clean = (email: string) => email.trim().toLowerCase();

function issue(email: string): Session {
  const expiresAt = Date.now() + MOCK_SESSION_SECONDS * 1000;
  return {
    email,
    expiresAt,
    token: encodeMockToken({ sub: subFor(email), email, "cognito:groups": ["owner"], exp: Math.floor(expiresAt / 1000) }),
  };
}

export const mockAuthClient: AuthClient = {
  sessionSeconds: MOCK_SESSION_SECONDS,

  async signIn(email, password) {
    const address = clean(email);
    if (password === "") throw new AuthError("bad_credentials");
    if (address === MOCK_EMAIL) return { step: "totp", challenge: address };
    const signup = signups.get(address);
    if (!signup) throw new AuthError("bad_credentials");
    if (!signup.confirmed) throw new AuthError("unconfirmed");
    return { step: "done", session: issue(address) };
  },

  async confirmTotp(challenge, code) {
    if (code.replace(/\s/g, "") !== MOCK_TOTP) throw new AuthError("bad_code");
    return issue(challenge);
  },

  // The mock owner already has an authenticator; signIn never asks for a setup.
  async confirmTotpSetup() {
    throw new AuthError("expired");
  },

  async signUp(email, password) {
    const address = clean(email);
    if (address === MOCK_EMAIL || signups.get(address)?.confirmed) throw new AuthError("email_taken");
    // The pool's policy: 12 characters with a capital, a small letter and a digit.
    if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) throw new AuthError("weak_password");
    signups.set(address, { confirmed: false });
  },

  async confirmSignUp(email, code) {
    const signup = signups.get(clean(email));
    if (!signup || code.replace(/\s/g, "") !== MOCK_SIGNUP_CODE) throw new AuthError("bad_code");
    signup.confirmed = true;
  },

  async resendSignUpCode() {},

  async requestPasswordReset() {},

  // Any password signs the mock's accounts in, so there is nothing to store.
  async confirmPasswordReset(email, code, password) {
    const address = clean(email);
    const known = address === MOCK_EMAIL || signups.get(address)?.confirmed;
    if (!known || code.replace(/\s/g, "") !== MOCK_SIGNUP_CODE) throw new AuthError("bad_code");
    if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) throw new AuthError("weak_password");
  },

  async refresh(session) {
    if (session.expiresAt <= Date.now()) throw new AuthError("expired");
    return issue(session.email);
  },

  async signOut() {},
};
