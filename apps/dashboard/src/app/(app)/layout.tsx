"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Link } from "react-aria-components";
import { useAuth } from "@/components/auth-provider";
import { ApiError } from "@/lib/api";
import { SessionKeeper } from "@/components/session-keeper";

const NAV = [
  { href: "/leads", label: "Leads" },
  { href: "/pricing", label: "Pricing" },
  { href: "/settings/area", label: "Service area" },
  { href: "/settings/embed", label: "Embed settings" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const { state, api, signOut, endedBy } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [companyName, setCompanyName] = useState<string | null>(null);

  useEffect(() => {
    if (state.status !== "signed-out") return;
    const query = new URLSearchParams({ next: pathname });
    if (endedBy === "expired") query.set("reason", "expired");
    router.replace(`/sign-in?${query}`);
  }, [state.status, endedBy, pathname, router]);

  const signedIn = state.status === "signed-in";
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    api.getCompany().then(
      (company) => !cancelled && setCompanyName(company.name),
      (error: unknown) => {
        // A login with no company yet: it is made on the onboarding screen.
        if (!cancelled && error instanceof ApiError && error.code === "forbidden") router.replace("/onboarding");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [signedIn, api, router]);

  if (state.status !== "signed-in") {
    return (
      <main className="centered">
        <title>InstaQuotesAI</title>
        <p role="status" className="muted">
          Checking your session&hellip;
        </p>
      </main>
    );
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app-header">
        <div className="app-header-row">
          <p className="brand">
            <span className="brand-name">InstaQuotesAI</span>
            {companyName && <span className="brand-company">{companyName}</span>}
          </p>
          {/* Help and account sit in the same place on every screen (3.2.6). */}
          <div className="app-header-tools">
            <Link className="link" href="/help" aria-current={pathname === "/help" ? "page" : undefined}>
              Help
            </Link>
            <span className="muted account-email">{state.session.email}</span>
            <Button className="btn" onPress={() => signOut("user")}>
              Sign out
            </Button>
          </div>
        </div>
        <nav aria-label="Main">
          <ul className="nav-list">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link className="nav-link" href={item.href} aria-current={pathname === item.href || pathname.startsWith(`${item.href}/`) ? "page" : undefined}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" className="app-main" tabIndex={-1}>
        {children}
      </main>
      <SessionKeeper session={state.session} />
    </>
  );
}
