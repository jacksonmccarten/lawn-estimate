"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Link } from "react-aria-components";
import { useAuth } from "@/components/auth-provider";
import { BusyButton, TextInput, noteRoute } from "@/components/ui";
import { isMockAuth } from "@/lib/auth/client";
import { MOCK_SIGNUP_CODE } from "@/lib/auth/mock-client";
import { PASSWORD_HINT, passwordProblem } from "@/lib/auth/password";
import { AuthError } from "@/lib/auth/types";

function SignUp() {
  const { state, signUp, confirmSignUp, resendSignUpCode, signIn } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  // Arriving from sign-in with an address that still needs its code.
  const resumeEmail = params.get("verify") ?? "";

  const [step, setStep] = useState<"details" | "verify">(resumeEmail ? "verify" : "details");
  const [email, setEmail] = useState(resumeEmail);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string; code?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => noteRoute("/sign-up"), []);

  // Signed in (after the code, or already): on to the company, which is made on first sign-in.
  useEffect(() => {
    if (state.status === "signed-in") router.replace("/onboarding");
  }, [state.status, router]);

  // The second step replaces the first: move focus to its field so it is not lost.
  useEffect(() => {
    if (step === "verify") codeRef.current?.focus();
  }, [step]);

  function fail(caught: unknown) {
    const reason = caught instanceof AuthError ? caught.code : "unknown";
    if (reason === "email_taken") {
      setErrors({ email: "An account with this email already exists. Sign in instead." });
      emailRef.current?.focus();
    } else if (reason === "weak_password") {
      setErrors({ password: PASSWORD_HINT });
      passwordRef.current?.focus();
    } else if (reason === "bad_code") {
      setErrors({ code: "That code isn’t right, or it has expired. Check the email, or send a new code." });
      codeRef.current?.focus();
    } else if (reason === "limit") {
      setError("Too many attempts. Wait a few minutes and try again.");
    } else if (reason === "not_configured") {
      setError("Creating accounts isn’t set up for this environment yet.");
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

    if (step === "details") {
      const address = email.trim();
      const problem = passwordProblem(password);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
        setErrors({ email: "Enter an email address like name@example.com." });
        emailRef.current?.focus();
        return;
      }
      if (problem) {
        setErrors({ password: problem });
        passwordRef.current?.focus();
        return;
      }
    } else if (!/^\d{6}$/.test(code.replace(/\s/g, ""))) {
      setErrors({ code: "Enter the 6-digit code from the email." });
      codeRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      if (step === "details") {
        await signUp(email, password);
        setStep("verify");
      } else {
        await confirmSignUp(email, code);
        // With the password still in hand, sign straight in; otherwise they sign in themselves.
        if (password) await signIn(email, password);
        else router.replace("/sign-in");
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
      await resendSignUpCode(email);
      setNotice("We sent a new code. It can take a minute to arrive.");
    } catch (caught) {
      fail(caught);
    }
  }

  return (
    <main className="centered">
      <title>{"Create an account · InstaQuotesAI"}</title>
      <div className="card sign-in">
        <p className="brand-name">InstaQuotesAI</p>
        <h1>{step === "details" ? "Create an account" : "Check your email"}</h1>
        {step === "verify" && (
          <p>
            We sent a 6-digit code to <span className="nowrap">{email.trim().toLowerCase()}</span>. Enter it to finish creating your account.
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
          {step === "details" ? (
            <>
              <TextInput label="Email" type="email" autoComplete="username" value={email} onChange={setEmail} inputRef={emailRef} error={errors.email} isRequired />
              <TextInput
                label="Password"
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
          ) : (
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
          )}
          <div className="form-actions">
            <BusyButton type="submit" className="btn primary" isBusy={pending}>
              {step === "details" ? "Create account" : "Verify email"}
            </BusyButton>
            {step === "verify" && (
              <Button className="btn" onPress={() => void resend()}>
                Send a new code
              </Button>
            )}
          </div>
        </form>
        <p className="hint">
          Already have an account?{" "}
          <Link className="link" href="/sign-in">
            Sign in
          </Link>
        </p>
        {isMockAuth && (
          <p className="hint mock-note">
            Local mock sign-up, not Cognito. No email is sent; the code is <code>{MOCK_SIGNUP_CODE}</code>.
          </p>
        )}
      </div>
    </main>
  );
}

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUp />
    </Suspense>
  );
}
