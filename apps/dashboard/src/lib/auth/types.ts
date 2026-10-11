// The seam between the dashboard and its identity provider. The design calls
// for a Cognito user pool with password + TOTP (§11, 3.3.8). Two
// implementations: cognito-client.ts for a real pool, and the local mock.

export type Session = {
  /** Sent as the bearer token to the company-api. */
  token: string;
  email: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
};

export type SignInStep =
  | { step: "totp"; challenge: string }
  /** First sign-in: the account has no authenticator yet. `secret` is the key to add to one. */
  | { step: "totp-setup"; challenge: string; secret: string }
  | { step: "done"; session: Session };

export class AuthError extends Error {
  constructor(
    /** `not_ready`: the account exists but its setup is unfinished (a temporary password). */
    readonly code:
      | "bad_credentials"
      | "bad_code"
      | "not_configured"
      | "expired"
      | "not_ready"
      /** Signed up, but the emailed code has not been entered yet. */
      | "unconfirmed"
      | "email_taken"
      | "weak_password"
      /** Too many tries; wait before the next. */
      | "limit"
      | "unknown",
  ) {
    super(code);
    this.name = "AuthError";
  }
}

export interface AuthClient {
  /** How long a fresh session lasts, for the refresh and warning timers. */
  readonly sessionSeconds: number;
  signIn(email: string, password: string): Promise<SignInStep>;
  confirmTotp(challenge: string, code: string): Promise<Session>;
  /** Finishes a `totp-setup` step with the first code from the newly added authenticator. */
  confirmTotpSetup(challenge: string, code: string): Promise<Session>;
  /** Creates a login and emails it a code. Rejects with `email_taken` or `weak_password`. */
  signUp(email: string, password: string): Promise<void>;
  /** Proves the address with the emailed code. Rejects with `bad_code`. */
  confirmSignUp(email: string, code: string): Promise<void>;
  resendSignUpCode(email: string): Promise<void>;
  /** Emails a reset code if the address has an account. Resolves either way, so it tells nobody who has one. */
  requestPasswordReset(email: string): Promise<void>;
  /** Sets a new password with the emailed code. Rejects with `bad_code` or `weak_password`. */
  confirmPasswordReset(email: string, code: string, password: string): Promise<void>;
  /** A new session from a live one. Rejects with AuthError("expired") if it is too late. */
  refresh(session: Session): Promise<Session>;
  signOut(session: Session): Promise<void>;
}
