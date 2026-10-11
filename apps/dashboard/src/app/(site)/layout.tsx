// The public website: home, about and contact, with the way in to the
// dashboard. Server-rendered and static; nothing here needs a session.

import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./site.css";

export const metadata: Metadata = {
  title: { default: "InstaQuoter AI: instant lawn care quotes", template: "%s · InstaQuoter AI" },
  description: "Instant lawn mowing quotes from your own website. Homeowners outline their lawn on a satellite photo and get your flat-rate price on the spot.",
  // The marketing pages are meant to be found; the dashboard is not (root layout).
  robots: { index: true, follow: true },
};

const NAV = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="site">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <div className="site-container site-header-row">
          <Link href="/" className="site-brand" aria-label="InstaQuoter AI home">
            <span className="site-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="28" height="28" focusable="false">
                <rect width="32" height="32" rx="8" fill="currentColor" />
                <path d="M7 22 L12 9 L25 12 L22 24 Z" fill="none" stroke="var(--on-accent)" strokeWidth="2.5" strokeLinejoin="round" />
                <circle cx="7" cy="22" r="2.2" fill="var(--on-accent)" />
                <circle cx="12" cy="9" r="2.2" fill="var(--on-accent)" />
                <circle cx="25" cy="12" r="2.2" fill="var(--on-accent)" />
                <circle cx="22" cy="24" r="2.2" fill="var(--on-accent)" />
              </svg>
            </span>
            <span className="site-wordmark">
              InstaQuoter <span className="site-wordmark-ai">AI</span>
            </span>
          </Link>
          <nav aria-label="Main" className="site-nav">
            <ul>
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="site-nav-link">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="site-header-actions">
            <Link href="/login" className="site-btn site-btn-ghost">
              Log In
            </Link>
            <Link href="/sign-up" className="site-btn site-btn-primary">
              Get Started
            </Link>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="site-container site-footer-row">
          <p>
            <strong>InstaQuoter AI</strong>
            <br />
            Instant lawn care quotes for lawn care businesses.
          </p>
          <nav aria-label="Footer">
            <ul>
              <li>
                <Link href="/about">About</Link>
              </li>
              <li>
                <Link href="/contact">Contact</Link>
              </li>
              <li>
                <Link href="/login">Log In</Link>
              </li>
            </ul>
          </nav>
          <p className="site-footer-small">© {new Date().getFullYear()} InstaQuoter AI</p>
        </div>
      </footer>
    </div>
  );
}
