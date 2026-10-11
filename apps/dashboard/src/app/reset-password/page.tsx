"use client";

// Forgotten password: ask for the address, email it a code, then take the
// code and a new password. The first step answers the same whether or not
// the address has an account, so it cannot be used to find out who does.

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Link } from "react-aria-components";
import { useAuth } from "@/components/auth-provider";
import { BusyButton, TextInput, noteRoute } from "@/components/ui";
import { isMockAuth } from "@/lib/auth/client";
import { MOCK_SIGNUP_CODE } from "@/lib/auth/mock-client";
import { PASSWORD_HINT, passwordProblem } from "@/lib/auth/password";
import { AuthError } from "@/lib/auth/types";

function ResetPassword() {
  const { requestPasswordReset, confirmPasswordReset } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  const [step, setStep] = useState<"request" | "confirm">("request");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; code?: string; password?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => noteRoute("/reset-password"), []);

  // The second step replaces the first: move focus to its first field so it is not lost.
  useEffect(() => {
    if (step === "confirm") codeRef.current?.focus();
  }, [step]);

  function fail(caught: unknown) {
    const reason = caught instanceof AuthError ? caught.code : "unknown";
    if (reason === "bad_code") {
      setErrors({ code: "That code isn’t right, or it has expired. Check the email, or send a new code." });
      codeRef.current?.focus();
    } else if (reason === "weak_password") {
      setErrors({ password: PASSWORD_HINT });
      passwordRef.current?.focus();
    } else if (reason === "limit") {
      setError("Too many attempts. Wait a few minutes and try again.");
    } else if (reason === "not_configured") {
      setError("Password reset isn’t set up for this environment yet.");
    } else {
      setError("We couldn’t do that just now. Try again in a moment.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setNotice(null);
    setErrors({});

    if (step === "request") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setErrors({ email: "Enter an email address like name@example.com." });
        emailRef.current?.focus();
        return;
      }
    } else {
      if (!/^\d{6}$/.test(code.replace(/\s/g, ""))) {
        setErrors({ code: "Enter the 6-digit code from the email." });
        codeRef.current?.focus();
        return;
      }
      const problem = passwordProblem(password);
      if (problem) {
        setErrors({ password: problem });
        passwordRef.current?.focus();
        return;
      }
    }

    setPending(true);
    try {
      if (step === "request") {
        await requestPasswordReset(email);
        setStep("confirm");
      } else {
        await confirmPasswordReset(email, code, password);
        router.replace("/sign-in?reset=1");
      }
    } catch (caught) {
      fail(caught);
    } finally {
      setPending(false);
    }
  }

  async function resend() {
    setError(null);
    setErrors({});
    try {
      await requestPasswordReset(email);
      setNotice("If that address has an account, we sent a new code. It can take a minute to arrive.");
    } catch (caught) {
      fail(caught);
    }
  }

  return (
    <main className="centered">
      <title>{"Reset your password · InstaQuotesAI"}</title>
      <div className="card sign-in">
        <p className="brand-name">InstaQuotesAI</p>
        <h1>{step === "request" ? "Reset your password" : "Choose a new password"}</h1>
        {step === "request" ? (
          <p>Enter the email address you sign in with. We’ll email you a code to set a new password.</p>
        ) : (
          <p>
            If <span className="nowrap">{email.trim().toLowerCase()}</span> has an account, we’ve emailed it a 6-digit code. Enter the code and a new
            password.
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        <form onSubmit={submit} noValidate>
          {step === "request" ? (
            <TextInput label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} inputRef={emailRef} error={errors.email} isRequired />
          ) : (
            <>
              <TextInput
                label="6-digit code"
                description="From the email we just sent."
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={setCode}
                inputRef={codeRef}
                error={errors.code}
                isRequired
              />
              <TextInput
                label="New password"
                description={PASSWORD_HINT}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={setPassword}
                inputRef={passwordRef}
                error={errors.password}
                isRequired
              />
            </>
          )}
          <div className="form-actions">
            <BusyButton type="submit" className="btn primary" isBusy={pending}>
              {step === "request" ? "Email me a code" : "Set new password"}
            </BusyButton>
            {step === "confirm" && (
              <Button className="btn" onPress={() => void resend()}>
                Send a new code
              </Button>
            )}
          </div>
        </form>
        <p className="hint">
          Remembered it?{" "}
          <Link className="link" href="/sign-in">
            Back to sign in
          </Link>
        </p>
        {isMockAuth && (
          <p className="hint mock-note">
            Local mock, not Cognito. No email is sent; the code is <code>{MOCK_SIGNUP_CODE}</code>.
          </p>
        )}
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
