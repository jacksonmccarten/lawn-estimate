import type { Metadata } from "next";

export const metadata: Metadata = { title: "Contact" };

export default function ContactPage() {
  return (
    <>
      <section className="page-hero" aria-labelledby="contact-heading">
        <div className="site-container narrow reveal">
          <p className="eyebrow">Contact</p>
          <h1 id="contact-heading">Talk to the InstaQuotesAI team</h1>
          <p className="hero-lead">Questions about getting started, pricing or your website? We’re happy to help.</p>
        </div>
      </section>
      <section className="site-section" aria-labelledby="reach-heading">
        <div className="site-container narrow">
          <div className="contact-card">
            <h2 id="reach-heading">InstaQuotesAI</h2>
            <dl className="contact-details">
              <dt>Phone</dt>
              <dd>
                <a href="tel:+12674050260" className="contact-phone">
                  267-405-0260
                </a>
              </dd>
            </dl>
            {/* More of the team's contact details go here as they're added. */}
          </div>
        </div>
      </section>
    </>
  );
}
