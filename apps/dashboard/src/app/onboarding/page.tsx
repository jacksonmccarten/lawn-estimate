"use client";

// A new account's first screen: it has a login and no company. Naming the
// company creates it, with a trial allowance and Pennsylvania as its service
// area; the owner then sets their own prices.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "react-aria-components";
import { useAuth } from "@/components/auth-provider";
import { BusyButton, TextInput, noteRoute } from "@/components/ui";
import { ApiError } from "@/lib/api";

export default function OnboardingPage() {
  const { state, api, signOut } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checked, setChecked] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => noteRoute("/onboarding"), []);

  useEffect(() => {
    if (state.status === "signed-out") router.replace("/sign-in?next=%2Fonboarding");
  }, [state.status, router]);

  // Someone who already has a company has nothing to do here.
  const signedIn = state.status === "signed-in";
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    api.getCompany().then(
      () => !cancelled && router.replace("/leads"),
      () => !cancelled && setChecked(true),
    );
    return () => {
      cancelled = true;
    };
  }, [signedIn, api, router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 120) {
      setFieldError(trimmed.length < 1 ? "Enter your company’s name." : "Shorten the name to 120 characters or fewer.");
      nameRef.current?.focus();
      return;
    }
    setFieldError(undefined);
    setPending(true);
    try {
      await api.createCompany({ name: trimmed });
      // A new account starts at its service area: where it works, then what it charges.
      router.replace("/settings/area");
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "conflict") router.replace("/leads");
      else if (caught instanceof ApiError && caught.code === "forbidden") setError("Verify your email address before setting up a company.");
      else setError("We couldn’t set up your company just now. Try again in a moment.");
      setPending(false);
    }
  }

  if (state.status !== "signed-in" || !checked) {
    return (
      <main className="centered">
        <title>Instant Lawn Quote</title>
        <p role="status" className="muted">
          Checking your account&hellip;
        </p>
      </main>
    );
  }

  return (
    <main className="centered">
      <title>{"Set up your company · Instant Lawn Quote"}</title>
      <div className="card sign-in">
        <p className="brand-name">Instant Lawn Quote</p>
        <h1>Set up your company</h1>
        <p>
          Signed in as <span className="nowrap">{state.session.email}</span>. Your company starts on a trial of 50 estimates a month,
          serving all of Pennsylvania. Next you’ll check where you work, then set your prices: homeowners see no quote until you publish them.
        </p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <form onSubmit={submit} noValidate>
          <TextInput
            label="Company name"
            description="Shown to homeowners at the top of your quote form. You can change it later."
            autoComplete="organization"
            value={name}
            onChange={setName}
            inputRef={nameRef}
            error={fieldError}
            isRequired
          />
          <div className="form-actions">
            <BusyButton type="submit" className="btn primary" isBusy={pending}>
              Create company
            </BusyButton>
            <Button className="btn" onPress={() => signOut("user")}>
              Sign out
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
