// The AuthClient for a Cognito user pool: password by SRP, then a code from
// an authenticator app. The pool has no self sign-up; an account is created
// for a company when it is onboarded, and its first sign-in sets up the
// authenticator.
//
// Tokens live in sessionStorage, where the session already is: they end with
// the tab, and a reload inside the tab can still refresh the session.

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserAttribute,
  type CognitoUserSession,
  type ICognitoStorage,
} from "amazon-cognito-identity-js";
import { AuthError, type AuthClient, type Session, type SignInStep } from "./types";

export type CognitoConfig = { userPoolId: string; clientId: string };

/** The ID and access tokens' lifetime, set on the pool's app client (infra/lib/state-stack.ts). */
const SESSION_SECONDS = 30 * 60;

/** What Cognito calls the failures the sign-in screen tells apart. */
function authError(err: unknown, during: "password" | "code"): AuthError {
  const name = (err as { name?: unknown; code?: unknown } | null)?.name ?? (err as { code?: unknown } | null)?.code;
  switch (name) {
    case "NotAuthorizedException":
      // A wrong password on the first step; on the second, the sign-in took too long.
      return new AuthError(during === "password" ? "bad_credentials" : "expired");
    case "UserNotFoundException":
      return new AuthError("bad_credentials");
    case "UserNotConfirmedException":
      return new AuthError("unconfirmed");
    case "UsernameExistsException":
      return new AuthError("email_taken");
    case "InvalidPasswordException":
      return new AuthError("weak_password");
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return new AuthError("limit");
    case "CodeMismatchException":
    case "EnableSoftwareTokenMFAException":
    case "ExpiredCodeException":
      return new AuthError("bad_code");
    default:
      return new AuthError("unknown");
  }
}

function toSession(session: CognitoUserSession): Session {
  // The ID token: its audience is the app client, which the API's authorizer checks, and it carries the groups.
  const token = session.getIdToken();
  return { token: token.getJwtToken(), email: String(token.payload.email ?? ""), expiresAt: token.getExpiration() * 1000 };
}

export function createCognitoClient(config: CognitoConfig, storage?: ICognitoStorage): AuthClient {
  const pool = (() => {
    let made: CognitoUserPool | undefined;
    // Made on first use: sessionStorage does not exist while the page is rendered on the server.
    return () => (made ??= new CognitoUserPool({ UserPoolId: config.userPoolId, ClientId: config.clientId, Storage: storage ?? window.sessionStorage }));
  })();

  // A sign-in between its password and its code: the user object holds Cognito's session for the challenge.
  const pending = new Map<string, CognitoUser>();
  const take = (challenge: string): CognitoUser => {
    const user = pending.get(challenge);
    if (!user) throw new AuthError("expired");
    return user;
  };

  return {
    sessionSeconds: SESSION_SECONDS,

    signIn(email, password) {
      const username = email.trim().toLowerCase();
      const user = new CognitoUser({ Username: username, Pool: pool(), Storage: storage ?? window.sessionStorage });
      const challenge = `${username}#${Date.now()}`;
      return new Promise<SignInStep>((resolve, reject) => {
        user.authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), {
          onSuccess: (session) => resolve({ step: "done", session: toSession(session) }),
          onFailure: (err) => reject(authError(err, "password")),
          totpRequired: () => {
            pending.set(challenge, user);
            resolve({ step: "totp", challenge });
          },
          // First sign-in: the pool requires an authenticator, and this account has none yet.
          mfaSetup: () => {
            user.associateSoftwareToken({
              associateSecretCode: (secret) => {
                pending.set(challenge, user);
                resolve({ step: "totp-setup", challenge, secret });
              },
              onFailure: (err) => reject(authError(err, "password")),
            });
          },
          // An account still on the temporary password it was created with. Onboarding sets a permanent one.
          newPasswordRequired: () => reject(new AuthError("not_ready")),
          // The pool sends no SMS codes.
          mfaRequired: () => reject(new AuthError("unknown")),
        });
      });
    },

    async confirmTotp(challenge, code) {
      const user = take(challenge);
      return new Promise<Session>((resolve, reject) => {
        user.sendMFACode(
          code.replace(/\s/g, ""),
          {
            onSuccess: (session) => {
              pending.delete(challenge);
              resolve(toSession(session));
            },
            onFailure: (err) => reject(authError(err, "code")),
          },
          "SOFTWARE_TOKEN_MFA",
        );
      });
    },

    async confirmTotpSetup(challenge, code) {
      const user = take(challenge);
      return new Promise<Session>((resolve, reject) => {
        user.verifySoftwareToken(code.replace(/\s/g, ""), "Authenticator app", {
          onSuccess: (session) => {
            pending.delete(challenge);
            resolve(toSession(session));
          },
          onFailure: (err) => reject(authError(err, "code")),
        });
      });
    },

    signUp(email, password) {
      const username = email.trim().toLowerCase();
      return new Promise<void>((resolve, reject) => {
        pool().signUp(username, password, [new CognitoUserAttribute({ Name: "email", Value: username })], [], (err) =>
          err ? reject(authError(err, "password")) : resolve(),
        );
      });
    },

    confirmSignUp(email, code) {
      const user = new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool(), Storage: storage ?? window.sessionStorage });
      return new Promise<void>((resolve, reject) => {
        user.confirmRegistration(code.replace(/\s/g, ""), true, (err: unknown) => (err ? reject(authError(err, "password")) : resolve()));
      });
    },

    resendSignUpCode(email) {
      const user = new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool(), Storage: storage ?? window.sessionStorage });
      return new Promise<void>((resolve, reject) => {
        user.resendConfirmationCode((err) => (err ? reject(authError(err, "password")) : resolve()));
      });
    },

    requestPasswordReset(email) {
      const user = new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool(), Storage: storage ?? window.sessionStorage });
      return new Promise<void>((resolve, reject) => {
        user.forgotPassword({
          onSuccess: () => resolve(),
          inputVerificationCode: () => resolve(),
          onFailure: (err) => {
            const failure = authError(err, "password");
            // Only being told to slow down is worth saying. Anything else (no such
            // account, an unverified address) looks the same as success from outside.
            if (failure.code === "limit") reject(failure);
            else resolve();
          },
        });
      });
    },

    confirmPasswordReset(email, code, password) {
      const user = new CognitoUser({ Username: email.trim().toLowerCase(), Pool: pool(), Storage: storage ?? window.sessionStorage });
      return new Promise<void>((resolve, reject) => {
        user.confirmPassword(code.replace(/\s/g, ""), password, {
          onSuccess: () => resolve(),
          // A wrong address fails the same way as a wrong code.
          onFailure: (err) => {
            const failure = authError(err, "password");
            reject(failure.code === "bad_credentials" ? new AuthError("bad_code") : failure);
          },
        });
      });
    },

    refresh() {
      const user = pool().getCurrentUser();
      if (!user) return Promise.reject(new AuthError("expired"));
      return new Promise<Session>((resolve, reject) => {
        // Loads the stored tokens; the refresh token then buys a new pair.
        user.getSession((err: Error | null, current: CognitoUserSession | null) => {
          if (err || !current) return reject(new AuthError("expired"));
          user.refreshSession(current.getRefreshToken(), (refreshError: unknown, next: CognitoUserSession | null) => {
            if (refreshError || !next) reject(new AuthError("expired"));
            else resolve(toSession(next));
          });
        });
      });
    },

    signOut() {
      const user = pool().getCurrentUser();
      if (!user) return Promise.resolve();
      // Revokes the refresh token and clears the stored tokens, whether or not Cognito answers.
      return new Promise<void>((resolve) => user.signOut(() => resolve()));
    },
  };
}
