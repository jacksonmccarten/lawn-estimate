"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createApi, type Api } from "@/lib/api";
import { authClient } from "@/lib/auth/client";
import type { Session, SignInStep } from "@/lib/auth/types";

type AuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; session: Session };

type AuthContextValue = {
  state: AuthState;
  api: Api;
  signIn: (email: string, password: string) => Promise<SignInStep>;
  confirmTotp: (challenge: string, code: string) => Promise<void>;
  confirmTotpSetup: (challenge: string, code: string) => Promise<void>;
  /** Sign-up does not sign in: the address is verified first, then `signIn` is called. */
  signUp: (email: string, password: string) => Promise<void>;
  confirmSignUp: (email: string, code: string) => Promise<void>;
  resendSignUpCode: (email: string) => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  confirmPasswordReset: (email: string, code: string, password: string) => Promise<void>;
  refresh: () => Promise<boolean>;
  /** `expired` keeps unsaved drafts in the tab so they survive signing back in. */
  signOut: (reason: "user" | "expired") => void;
  /** Set when the last session ended on its own, until the next sign-in. */
  endedBy: "expired" | null;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// sessionStorage: the session ends with the tab. The Cognito adapter keeps its
// tokens there too.
const SESSION_KEY = "lq.session";
export const DRAFT_KEY_PREFIX = "lq.draft.";

function readStoredSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    return typeof session.token === "string" && session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [endedBy, setEndedBy] = useState<"expired" | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const store = useCallback((session: Session | null) => {
    sessionRef.current = session;
    try {
      if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Storage can be unavailable; the session then lasts until reload.
    }
    setState(session ? { status: "signed-in", session } : { status: "signed-out" });
  }, []);

  useEffect(() => {
    store(readStoredSession());
  }, [store]);

  const signOut = useCallback(
    (reason: "user" | "expired") => {
      const session = sessionRef.current;
      if (session) void authClient.signOut(session);
      if (reason === "user") {
        try {
          for (const key of Object.keys(sessionStorage)) if (key.startsWith(DRAFT_KEY_PREFIX)) sessionStorage.removeItem(key);
        } catch {
          // Nothing to clear.
        }
      }
      setEndedBy(reason === "expired" ? "expired" : null);
      store(null);
    },
    [store],
  );

  const refresh = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return false;
    try {
      store(await authClient.refresh(session));
      return true;
    } catch {
      return false;
    }
  }, [store]);

  const api = useMemo(
    () =>
      createApi({
        baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "",
        getToken: () => sessionRef.current?.token ?? null,
        onUnauthenticated: () => signOut("expired"),
      }),
    [signOut],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      api,
      endedBy,
      refresh,
      signOut,
      signUp: (email, password) => authClient.signUp(email, password),
      confirmSignUp: (email, code) => authClient.confirmSignUp(email, code),
      resendSignUpCode: (email) => authClient.resendSignUpCode(email),
      requestPasswordReset: (email) => authClient.requestPasswordReset(email),
      confirmPasswordReset: (email, code, password) => authClient.confirmPasswordReset(email, code, password),
      signIn: async (email, password) => {
        const step = await authClient.signIn(email, password);
        if (step.step === "done") {
          setEndedBy(null);
          store(step.session);
        }
        return step;
      },
      confirmTotp: async (challenge, code) => {
        const session = await authClient.confirmTotp(challenge, code);
        setEndedBy(null);
        store(session);
      },
      confirmTotpSetup: async (challenge, code) => {
        const session = await authClient.confirmTotpSetup(challenge, code);
        setEndedBy(null);
        store(session);
      },
    }),
    [state, api, endedBy, refresh, signOut, store],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth needs an AuthProvider");
  return value;
}

export function useApi(): Api {
  return useAuth().api;
}
