// The homepage: what InstaQuoter AI is, how it works, and the way to sign up.

import Link from "next/link";

const STEPS = [
  { title: "Add InstaQuoter to Your Website", body: "Embed the quoting widget directly into your existing website." },
  { title: "Customers Measure Their Lawn", body: "Homeowners enter their address and outline their lawn using an interactive satellite map." },
  {
    title: "Generate Instant Pricing",
    body: "InstaQuoter calculates the lawn area and provides a price based on the business's configured pricing categories.",
  },
  { title: "Convert Leads Into Customers", body: "Customers can proceed toward booking through the integrated quoting workflow." },
];

const BENEFITS = [
  { title: "Instant estimates, 24/7", body: "Homeowners get a lawn mowing price the moment they ask, day or night." },
  { title: "Less time measuring", body: "No more driving out to measure properties or building quotes by hand." },
  { title: "More conversions", body: "Turn more website visitors into paying customers while they're still interested." },
  { title: "Customizable flat-rate pricing", body: "Set your own lawn size categories and the flat rate for each." },
  { title: "Custom customer questionnaires", body: "Ask about gates, hills, pools and anything else you need to know." },
  { title: "Simple website integration", body: "One line of code on Squarespace, Wix, WordPress or your own site." },
  { title: "Fits how you already work", body: "Leads arrive with the lawn size, price and answers, ready for your workflow." },
];

/** A decorative sketch of the product: a lawn outlined on a satellite photo, the house cut out, and the price. */
function HeroArt() {
  return (
    <svg className="hero-art" viewBox="0 0 480 380" role="presentation" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="grass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3f7d4a" />
          <stop offset="1" stopColor="#2c5f37" />
        </linearGradient>
        <pattern id="mow" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
          <rect width="12" height="24" fill="#ffffff" opacity="0.06" />
        </pattern>
      </defs>
      <rect x="10" y="10" width="400" height="320" rx="18" fill="url(#grass)" />
      <rect x="10" y="10" width="400" height="320" rx="18" fill="url(#mow)" />
      {/* The street and the driveway. */}
      <rect x="10" y="286" width="400" height="44" fill="#6b6f6a" />
      <rect x="250" y="190" width="44" height="100" fill="#9a9e98" />
      {/* The house and a pool. */}
      <rect x="196" y="110" width="128" height="86" rx="4" fill="#b9a68f" />
      <path d="M196 110 L260 80 L324 110 Z" fill="#8c7a66" />
      <rect x="80" y="70" width="70" height="44" rx="10" fill="#57b8d9" />
      {/* The outline the homeowner drew, and what they left out. */}
      <path className="hero-outline" d="M40 40 L380 46 L384 270 L44 266 Z" fill="#22c55e" fillOpacity="0.28" stroke="#22c55e" strokeWidth="4" strokeLinejoin="round" />
      <path d="M190 104 L330 104 L330 202 L190 202 Z" fill="#ef4444" fillOpacity="0.3" stroke="#ef4444" strokeWidth="3" strokeDasharray="8 6" />
      {[
        [40, 40],
        [380, 46],
        [384, 270],
        [44, 266],
      ].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="7" fill="#ffffff" stroke="#14532d" strokeWidth="3" />
      ))}
      {/* The quote card. */}
      <g className="hero-card">
        <rect x="280" y="236" width="190" height="124" rx="16" fill="var(--surface)" stroke="var(--border)" />
        <text x="300" y="268" fontSize="14" fill="var(--muted)">
          Lawn area
        </text>
        <text x="300" y="292" fontSize="20" fontWeight="700" fill="var(--text)">
          8,400 sq ft
        </text>
        <text x="300" y="322" fontSize="14" fill="var(--muted)">
          Mowing estimate
        </text>
        <text x="300" y="346" fontSize="22" fontWeight="800" fill="var(--accent)">
          $60.00
        </text>
      </g>
    </svg>
  );
}

export default function HomePage() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-heading">
        <div className="site-container hero-grid">
          <div className="hero-copy reveal">
            <h1 id="hero-heading">Instant Lawn Care Quotes. More Customers. Less Work.</h1>
            <p className="hero-lead">
              InstaQuoter AI helps lawn care businesses automate their estimating process. Customers can measure their lawns, receive instant pricing, and
              move toward booking services directly from your website — saving you time and helping you convert more leads.
            </p>
            <div className="hero-actions">
              <Link href="/sign-up" className="site-btn site-btn-primary site-btn-lg">
                Get Started
              </Link>
              <a href="#how-it-works" className="site-btn site-btn-secondary site-btn-lg">
                See How It Works
              </a>
              <Link href="/login" className="site-btn site-btn-ghost site-btn-lg">
                Log In
              </Link>
            </div>
          </div>
          <div className="hero-visual reveal reveal-delay">
            <HeroArt />
          </div>
        </div>
      </section>

      <section id="how-it-works" className="site-section" aria-labelledby="how-heading" tabIndex={-1}>
        <div className="site-container">
          <p className="eyebrow">How it works</p>
          <h2 id="how-heading">From website visitor to booked customer in four steps</h2>
          <ol className="steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className="step reveal" style={{ animationDelay: `${i * 80}ms` }}>
                <span className="step-number" aria-hidden="true">
                  {i + 1}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="site-section site-section-alt" aria-labelledby="benefits-heading">
        <div className="site-container">
          <p className="eyebrow">Why InstaQuoter AI</p>
          <h2 id="benefits-heading">Built for lawn care businesses</h2>
          <ul className="benefits">
            {BENEFITS.map((benefit) => (
              <li key={benefit.title} className="benefit">
                <svg className="benefit-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">
                  <circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.15" />
                  <path d="M7 12.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <div>
                  <h3>{benefit.title}</h3>
                  <p>{benefit.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="site-section" aria-labelledby="cta-heading">
        <div className="site-container">
          <div className="cta">
            <h2 id="cta-heading">Start quoting lawns instantly</h2>
            <p>Set your service area, your flat rates and your questions, then add the widget to your site. Signing up takes a few minutes.</p>
            <div className="hero-actions">
              <Link href="/sign-up" className="site-btn site-btn-light site-btn-lg">
                Get Started
              </Link>
              <Link href="/contact" className="site-btn site-btn-outline-light site-btn-lg">
                Talk to us
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
