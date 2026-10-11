// The Cognito adapter against a scripted stand-in for the Cognito library:
// which step each of Cognito's answers becomes, and which error.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Callbacks = Record<string, (...args: unknown[]) => void>;

/** What the next call into the fake library should do. */
const script: {
  authenticate?: (cb: Callbacks) => void;
  mfaCode?: (code: string, cb: Callbacks) => void;
  verifyToken?: (code: string, cb: Callbacks) => void;
  signUp?: (email: string, password: string, attributes: { data: { Name: string; Value: string } }[]) => Error | null;
  confirm?: (code: string) => Error | null;
  resend?: () => Error | null;
  forgot?: (cb: Callbacks) => void;
  confirmPassword?: (code: string, password: string, cb: Callbacks) => void;
  current?: object | null;
} = {};

const session = (email: string, exp: number) => ({
  getIdToken: () => ({ getJwtToken: () => `id.${email}`, getExpiration: () => exp, payload: { email } }),
  getRefreshToken: () => ({ token: "refresh" }),
});

vi.mock("amazon-cognito-identity-js", () => ({
  AuthenticationDetails: class {
    constructor(readonly data: unknown) {}
  },
  CognitoUserAttribute: class {
    constructor(readonly data: { Name: string; Value: string }) {}
  },
  CognitoUserPool: class {
    getCurrentUser() {
      return script.current ?? null;
    }
    signUp(email: string, password: string, attributes: { data: { Name: string; Value: string } }[], _validation: unknown, cb: (err: Error | null) => void) {
      cb(script.signUp!(email, password, attributes));
    }
  },
  CognitoUser: class {
    constructor(readonly data: { Username: string }) {}
    authenticateUser(_details: unknown, cb: Callbacks) {
      script.authenticate!(cb);
    }
    associateSoftwareToken(cb: Callbacks) {
      cb.associateSecretCode!("JBSWY3DPEHPK3PXP");
    }
    sendMFACode(code: string, cb: Callbacks) {
      script.mfaCode!(code, cb);
    }
    verifySoftwareToken(code: string, _name: string, cb: Callbacks) {
      script.verifyToken!(code, cb);
    }
    confirmRegistration(code: string, _force: boolean, cb: (err: Error | null) => void) {
      cb(script.confirm!(code));
    }
    resendConfirmationCode(cb: (err: Error | null) => void) {
      cb(script.resend!());
    }
    forgotPassword(cb: Callbacks) {
      script.forgot!(cb);
    }
    confirmPassword(code: string, password: string, cb: Callbacks) {
      script.confirmPassword!(code, password, cb);
    }
  },
}));

const { createCognitoClient } = await import("../src/lib/auth/cognito-client");
const storage = { setItem: () => "", getItem: () => "", removeItem: () => {}, clear: () => {} };
const client = () => createCognitoClient({ userPoolId: "us-east-2_test", clientId: "client" }, storage);
const named = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => {
  for (const key of Object.keys(script)) delete script[key as keyof typeof script];
});

describe("signIn", () => {
  it("asks for a code when the account has an authenticator, and signs in with it", async () => {
    const auth = client();
    script.authenticate = (cb) => cb.totpRequired!();
    const step = await auth.signIn("  Owner@Example.com ", "pw");
    expect(step).toMatchObject({ step: "totp" });

    script.mfaCode = (code, cb) => (code === "123456" ? cb.onSuccess!(session("owner@example.com", 2_000_000_000)) : cb.onFailure!(named("CodeMismatchException")));
    const challenge = (step as { challenge: string }).challenge;
    await expect(auth.confirmTotp(challenge, "000000")).rejects.toMatchObject({ code: "bad_code" });
    // Spaces typed between the digits are dropped; the ID token is the bearer token.
    expect(await auth.confirmTotp(challenge, "123 456")).toEqual({ token: "id.owner@example.com", email: "owner@example.com", expiresAt: 2_000_000_000_000 });
    // A challenge is used once.
    await expect(auth.confirmTotp(challenge, "123456")).rejects.toMatchObject({ code: "expired" });
  });

  it("hands over the setup key on a first sign-in, and finishes with the first code", async () => {
    const auth = client();
    script.authenticate = (cb) => cb.mfaSetup!();
    const step = await auth.signIn("owner@example.com", "pw");
    expect(step).toMatchObject({ step: "totp-setup", secret: "JBSWY3DPEHPK3PXP" });

    script.verifyToken = (code, cb) => (code === "654321" ? cb.onSuccess!(session("owner@example.com", 2_000_000_000)) : cb.onFailure!(named("EnableSoftwareTokenMFAException")));
    const challenge = (step as { challenge: string }).challenge;
    await expect(auth.confirmTotpSetup(challenge, "111111")).rejects.toMatchObject({ code: "bad_code" });
    expect((await auth.confirmTotpSetup(challenge, "654321")).token).toBe("id.owner@example.com");
  });

  it("does not say whether it was the email or the password that was wrong", async () => {
    for (const name of ["NotAuthorizedException", "UserNotFoundException"]) {
      script.authenticate = (cb) => cb.onFailure!(named(name));
      await expect(client().signIn("owner@example.com", "pw")).rejects.toMatchObject({ code: "bad_credentials" });
    }
  });

  it("reports an account still on its temporary password as not ready, and anything else as unknown", async () => {
    script.authenticate = (cb) => cb.newPasswordRequired!();
    await expect(client().signIn("owner@example.com", "pw")).rejects.toMatchObject({ code: "not_ready" });
    script.authenticate = (cb) => cb.onFailure!(named("InternalErrorException"));
    await expect(client().signIn("owner@example.com", "pw")).rejects.toMatchObject({ code: "unknown" });
  });

  it("tells an unverified account and a throttled one apart from a wrong password", async () => {
    script.authenticate = (cb) => cb.onFailure!(named("UserNotConfirmedException"));
    await expect(client().signIn("owner@example.com", "pw")).rejects.toMatchObject({ code: "unconfirmed" });
    script.authenticate = (cb) => cb.onFailure!(named("TooManyRequestsException"));
    await expect(client().signIn("owner@example.com", "pw")).rejects.toMatchObject({ code: "limit" });
  });

  it("treats a code entered after Cognito's sign-in session lapsed as expired", async () => {
    const auth = client();
    script.authenticate = (cb) => cb.totpRequired!();
    const step = (await auth.signIn("owner@example.com", "pw")) as { challenge: string };
    script.mfaCode = (_code, cb) => cb.onFailure!(named("NotAuthorizedException"));
    await expect(auth.confirmTotp(step.challenge, "123456")).rejects.toMatchObject({ code: "expired" });
  });
});

describe("sign-up", () => {
  it("creates the login under the lower-cased address, with the address as its email", async () => {
    const seen: unknown[] = [];
    script.signUp = (email, password, attributes) => {
      seen.push(email, password, attributes.map((a) => a.data));
      return null;
    };
    await client().signUp("  New.Owner@Example.com ", "Correct-Horse-9");
    expect(seen).toEqual(["new.owner@example.com", "Correct-Horse-9", [{ Name: "email", Value: "new.owner@example.com" }]]);
  });

  it("says when the address is taken or the password is too weak", async () => {
    script.signUp = () => named("UsernameExistsException");
    await expect(client().signUp("a@example.com", "pw")).rejects.toMatchObject({ code: "email_taken" });
    script.signUp = () => named("InvalidPasswordException");
    await expect(client().signUp("a@example.com", "pw")).rejects.toMatchObject({ code: "weak_password" });
  });

  it("confirms with the emailed code, spaces dropped, and reports a wrong or expired one", async () => {
    script.confirm = (code) => (code === "123456" ? null : named("CodeMismatchException"));
    await expect(client().confirmSignUp("a@example.com", "123 456")).resolves.toBeUndefined();
    await expect(client().confirmSignUp("a@example.com", "000000")).rejects.toMatchObject({ code: "bad_code" });
    script.confirm = () => named("ExpiredCodeException");
    await expect(client().confirmSignUp("a@example.com", "123456")).rejects.toMatchObject({ code: "bad_code" });
  });

  it("sends a new code, unless Cognito says to wait", async () => {
    script.resend = () => null;
    await expect(client().resendSignUpCode("a@example.com")).resolves.toBeUndefined();
    script.resend = () => named("LimitExceededException");
    await expect(client().resendSignUpCode("a@example.com")).rejects.toMatchObject({ code: "limit" });
  });
});

describe("forgotten password", () => {
  it("answers the same whether or not the address has an account", async () => {
    script.forgot = (cb) => cb.inputVerificationCode!({});
    await expect(client().requestPasswordReset("a@example.com")).resolves.toBeUndefined();
    for (const name of ["UserNotFoundException", "InvalidParameterException", "NotAuthorizedException"]) {
      script.forgot = (cb) => cb.onFailure!(named(name));
      await expect(client().requestPasswordReset("nobody@example.com"), name).resolves.toBeUndefined();
    }
    // Being told to slow down is the one thing passed on.
    script.forgot = (cb) => cb.onFailure!(named("LimitExceededException"));
    await expect(client().requestPasswordReset("a@example.com")).rejects.toMatchObject({ code: "limit" });
  });

  it("sets the new password with the emailed code, spaces dropped", async () => {
    const seen: string[] = [];
    script.confirmPassword = (code, password, cb) => {
      seen.push(code, password);
      cb.onSuccess!("SUCCESS");
    };
    await expect(client().confirmPasswordReset("A@Example.com", "123 456", "Correct-Horse-9")).resolves.toBeUndefined();
    expect(seen).toEqual(["123456", "Correct-Horse-9"]);
  });

  it("reports a wrong code, a wrong address and a weak password", async () => {
    const cases = [
      ["CodeMismatchException", "bad_code"],
      ["ExpiredCodeException", "bad_code"],
      ["UserNotFoundException", "bad_code"],
      ["InvalidPasswordException", "weak_password"],
      ["LimitExceededException", "limit"],
    ] as const;
    for (const [name, code] of cases) {
      script.confirmPassword = (_c, _p, cb) => cb.onFailure!(named(name));
      await expect(client().confirmPasswordReset("a@example.com", "123456", "pw"), name).rejects.toMatchObject({ code });
    }
  });
});

describe("refresh and signOut", () => {
  const stored = { token: "old", email: "owner@example.com", expiresAt: 1 };

  it("buys a new session with the stored refresh token", async () => {
    script.current = {
      getSession: (cb: (err: null, s: unknown) => void) => cb(null, session("owner@example.com", 1)),
      refreshSession: (_token: unknown, cb: (err: null, s: unknown) => void) => cb(null, session("owner@example.com", 2_000_000_100)),
    };
    expect(await client().refresh(stored)).toMatchObject({ expiresAt: 2_000_000_100_000 });
  });

  it("is expired when there are no stored tokens, or Cognito refuses the refresh", async () => {
    await expect(client().refresh(stored)).rejects.toMatchObject({ code: "expired" });
    script.current = {
      getSession: (cb: (err: null, s: unknown) => void) => cb(null, session("owner@example.com", 1)),
      refreshSession: (_token: unknown, cb: (err: Error) => void) => cb(named("NotAuthorizedException")),
    };
    await expect(client().refresh(stored)).rejects.toMatchObject({ code: "expired" });
  });

  it("signs out through the library, and is a no-op with nobody signed in", async () => {
    const signOut = vi.fn((done: () => void) => done());
    script.current = { signOut };
    await client().signOut(stored);
    expect(signOut).toHaveBeenCalledOnce();
    script.current = null;
    await expect(client().signOut(stored)).resolves.toBeUndefined();
  });
});
