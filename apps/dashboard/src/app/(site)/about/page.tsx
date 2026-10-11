import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "About us" };

const VALUES = [
  { title: "Penn State engineering", body: "We’re engineering students at Penn State, used to taking a real problem apart and building something that solves it." },
  { title: "Entrepreneurship and technology", body: "We started InstaQuotesAI because we love building products that people actually use." },
  { title: "Efficiency for home services", body: "Our mission is to help home service businesses spend less time on paperwork and more time on the work." },
  { title: "Practical, affordable automation", body: "Simple, affordable tools a small business can set up quickly and rely on every day." },
];

export default function AboutPage() {
  return (
    <>
      <section className="page-hero" aria-labelledby="about-heading">
        <div className="site-container narrow reveal">
          <p className="eyebrow">About us</p>
          <h1 id="about-heading">Making home services more efficient</h1>
          <p className="hero-lead">We are a team of Penn State engineering students passionate about making home services more efficient.</p>
        </div>
      </section>
      <section className="site-section" aria-labelledby="mission-heading">
        <div className="site-container narrow prose-site">
          <h2 id="mission-heading">Our mission</h2>
          <p>
            We believe small businesses deserve access to powerful, easy-to-use technology that saves time, simplifies operations, and helps them grow.
          </p>
          <p>
            InstaQuotesAI was created to make lawn care estimating faster, easier, and more convenient for both businesses and their customers.
          </p>
        </div>
      </section>
      <section className="site-section site-section-alt" aria-labelledby="values-heading">
        <div className="site-container">
          <h2 id="values-heading">What we care about</h2>
          <ul className="benefits">
            {VALUES.map((value) => (
              <li key={value.title} className="benefit">
                <div>
                  <h3>{value.title}</h3>
                  <p>{value.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="section-cta">
            <Link href="/contact" className="site-btn site-btn-primary">
              Get in touch
            </Link>
          </p>
        </div>
      </section>
    </>
  );
}
