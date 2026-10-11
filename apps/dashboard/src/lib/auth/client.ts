import { createCognitoClient } from "./cognito-client";
import { mockAuthClient } from "./mock-client";
import { AuthError, type AuthClient } from "./types";

const notConfigured: AuthClient = {
  sessionSeconds: 0,
  signIn: () => Promise.reject(new AuthError("not_configured")),
  confirmTotp: () => Promise.reject(new AuthError("not_configured")),
  confirmTotpSetup: () => Promise.reject(new AuthError("not_configured")),
  signUp: () => Promise.reject(new AuthError("not_configured")),
  confirmSignUp: () => Promise.reject(new AuthError("not_configured")),
  resendSignUpCode: () => Promise.reject(new AuthError("not_configured")),
  requestPasswordReset: () => Promise.reject(new AuthError("not_configured")),
  confirmPasswordReset: () => Promise.reject(new AuthError("not_configured")),
  refresh: () => Promise.reject(new AuthError("not_configured")),
  signOut: () => Promise.resolve(),
};

export const isMockAuth = process.env.NEXT_PUBLIC_LQ_MOCK === "1";

const userPoolId = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "";
const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "";

/** The mock when its switch is on, Cognito when a pool is configured, and otherwise nobody can sign in. */
export const authClient: AuthClient = isMockAuth
  ? mockAuthClient
  : userPoolId && clientId
    ? createCognitoClient({ userPoolId, clientId })
    : notConfigured;
