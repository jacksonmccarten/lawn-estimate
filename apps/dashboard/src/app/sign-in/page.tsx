"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Link } from "react-aria-components";
import { useAuth } from "@/components/auth-provider";
import { BusyButton, TextInput, noteRoute } from "@/components/ui";
import { isMockAuth } from "@/lib/auth/client";
import { MOCK_EMAIL, MOCK_TOTP } from "@/lib/auth/mock-client";
import { AuthError } from "@/lib/auth/types";

/** Only a path on this site: `next` comes from the URL. */
function safeNext(next: string | null): string {
  return next && /^\/(?!\/)/.test(next) && !next.startsWith("/sign-in") ? next : "/leads";
}

function SignIn() {
  const { state, signIn, confirmTotp, confirmTotpSetup } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const expired = params.get("reason") === "expired";
  const justReset = params.get("reset") === "1";

  const [step, setStep] = useState<"password" | "totp" | "totp-setup">("password");
  // First sign-in only: the key to add to an authenticator app.
  const [secret, setSecret] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => noteRoute("/sign-in"), []);

  useEffect(() => {
    if (state.status === "signed-in") router.replace(next);
  }, [state.status, next, router]);

  // The second step replaces the first: move focus to its field so it is not lost.
  useEffect(() => {
    if (step === "totp") codeRef.current?.focus();
    // The setup step has instructions to read first, so it starts at its heading.
    if (step === "totp-setup") headingRef.current?.focus();
  }, [step]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      if (step === "password") {
        const result = await signIn(email, password);
        if (result.step === "totp") {
          setChallenge(result.challenge);
          setStep("totp");
        } else if (result.step === "totp-setup") {
          setChallenge(result.challenge);
          setSecret(result.secret);
          setStep("totp-setup");
        }
      } else if (step === "totp-setup") {
        await confirmTotpSetup(challenge, code);
      } else {
        await confirmTotp(challenge, code);
      }
    } catch (caught) {
      const reason = caught instanceof AuthError ? caught.code : "unknown";
      if (reason === "bad_credentials") {
        setError("That email and password don’t match an account. Check both and try again.");
        emailRef.current?.focus();
      } else if (reason === "bad_code") {
        setError("That code isn’t right. Enter the current 6-digit code from your authenticator app.");
        codeRef.current?.focus();
      } else if (reason === "expired") {
        setError("That took too long, so the sign-in was cancelled. Start again with your email and password.");
        setStep("password");
        setCode("");
      } else if (reason === "unconfirmed") {
        // The account exists but its emailed code was never entered: finish that first.
        router.replace(`/sign-up?verify=${encodeURIComponent(email.trim().toLowerCase())}`);
      } else if (reason === "limit") {
        setError("Too many attempts. Wait a few minutes and try again.");
      } else if (reason === "not_ready") {
        setError("This account isn’t finished being set up. Contact us and we’ll complete it.");
      } else if (reason === "not_configured") {
        setError("Sign-in isn’t set up for this environment yet.");
      } else {
        setError("We couldn’t sign you in. Try again in a moment.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="centered">
      <title>{"Sign in · InstaQuotesAI"}</title>
      <div className="card sign-in">
        <p className="brand-name">InstaQuotesAI</p>
        <h1 ref={headingRef} tabIndex={-1}>
          {step === "password" ? "Sign in" : step === "totp" ? "Enter your code" : "Set up your authenticator app"}
        </h1>
        {expired && step === "password" && (
          <p role="status" className="notice">
            You were signed out after a period of inactivity. Unsaved pricing changes are still in this browser tab.
          </p>
        )}
        {justReset && step === "password" && (
          <p role="status" className="notice">
            Your password has been changed. Sign in with the new one.
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error" id="sign-in-error">
            {error}
          </p>
        )}
        <form onSubmit={submit} noValidate>
          {step === "password" ? (
            <>
              <TextInput label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} inputRef={emailRef} isRequired />
              <TextInput label="Password" type="password" autoComplete="current-password" value={password} onChange={setPassword} isRequired />
            </>
          ) : (
            <>
              {step === "totp-setup" && (
                <div className="totp-setup">
                  <p>
                    Signing in needs a code from an authenticator app, such as Google Authenticator, Microsoft Authenticator or
                    1Password. This is a one-time setup.
                  </p>
                  <ol>
                    <li>In the app, add an account and choose to enter a setup key.</li>
                    <li>
                      Enter this key, with <span className="nowrap">{email.trim().toLowerCase()}</span> as the account name:
                      <code className="totp-key" aria-label={`Setup key: ${secret.split("").join(" ")}`}>
                        {secret.replace(/(.{4})/g, "$1 ").trim()}
                      </code>
                    </li>
                    <li>Enter the 6-digit code the app shows.</li>
                  </ol>
                  <p>
                    On this phone already?{" "}
                    <a href={`otpauth://totp/${encodeURIComponent(`InstaQuotesAI:${email.trim().toLowerCase()}`)}?secret=${secret}&issuer=${encodeURIComponent("InstaQuotesAI")}`}>
                      Open it in your authenticator app
                    </a>
                    .
                  </p>
                </div>
              )}
            <TextInput
              label="6-digit code"
              description="From your authenticator app."
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={setCode}
              inputRef={codeRef}
              isRequired
            />
            </>
          )}
          <div className="form-actions">
            <BusyButton type="submit" className="btn primary" isBusy={pending}>
              {step === "password" ? "Continue" : "Sign in"}
            </BusyButton>
            {step !== "password" && (
              <Button
                className="btn"
                onPress={() => {
                  setStep("password");
                  setCode("");
                  setError(null);
                }}
              >
                Use a different account
              </Button>
            )}
          </div>
        </form>
        {step === "password" && (
          <p className="hint">
            <Link className="link" href={email.trim() ? `/reset-password?email=${encodeURIComponent(email.trim().toLowerCase())}` : "/reset-password"}>
              Forgot your password?
            </Link>
          </p>
        )}
        {step === "password" && (
          <p className="hint">
            New here?{" "}
            <Link className="link" href="/sign-up">
              Create an account
            </Link>
          </p>
        )}
        {isMockAuth && (
          <p className="hint mock-note">
            Local mock sign-in, not Cognito. Email <code>{MOCK_EMAIL}</code>, any password, code <code>{MOCK_TOTP}</code>.
          </p>
        )}
      </div>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
