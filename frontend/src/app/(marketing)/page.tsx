import Link from "next/link";
import { ROUTES } from "@/config/routes";

const FEATURES = [
  { tag: "01", title: "Route combinations", body: "Stations are nodes, trains are edges. We search every sensible chain of trains between two cities, not just the direct one." },
  { tag: "02", title: "Confirmed-seat ranking", body: "Options are ranked by how likely each leg is to be confirmed, then by fare and duration, so waitlists fall to the bottom." },
  { tag: "03", title: "Auto-book", body: "Set a fare cap and berth preference. Reroute tries the best options in order and books the first one that clears." },
  { tag: "04", title: "AI assistant", body: "Say “Delhi to Mumbai next Friday, 2 people, AC 3 tier” and get bookable options back in the chat." },
  { tag: "05", title: "Bookings & refunds", body: "Track PNR status, see the refund quote before you cancel, and watch waitlists get promoted." },
  { tag: "06", title: "Saved journeys", body: "Bookmark a route you like and come back to it when you are ready to travel." },
];

const STEPS = [
  { title: "Tell us where and when", body: "Source, destination, date, passengers, class and berth preference." },
  { title: "Compare real options", body: "Direct and multi-train routes side by side, with seat availability and confirm chance per leg." },
  { title: "Book or auto-book", body: "Pick one yourself, or let Reroute book the first option that fits your limits." },
];

const FAQ = [
  { q: "What does “reroute” mean here?", a: "If the direct train is full, we look for itineraries that change at an intermediate station so every leg has a seat." },
  { q: "Do I need an account?", a: "Yes, to book, save journeys and use the assistant. Sign up with email, GitHub or Google." },
  { q: "Can I cancel a booking?", a: "Yes. You see the refund amount and the rule that applies before you confirm the cancellation." },
  { q: "Which trains are covered?", a: "The timetable and availability data bundled with this project, covering the stations in the search box." },
];

function RouteVisual() {
  return (
    <div className="route-visual cad" aria-hidden="true">
      <p className="route-visual-label">Delhi → Mumbai · 14 Nov</p>
      <div className="rv-row rv-bad">
        <span>Direct</span>
        <span className="rv-line" />
        <span className="chip chip-bad">WL 42</span>
      </div>
      <div className="rv-row rv-good">
        <span>Reroute</span>
        <span className="rv-line rv-stops">
          <i />
          <i />
          <i />
        </span>
        <span className="chip chip-ok">Confirmed</span>
      </div>
      <p className="rv-meta">NDLS → KOTA → BCT · 2 trains · ₹1,980</p>
    </div>
  );
}

export default function LandingPage() {
  return (
    <>
      <section className="m-hero">
        <div className="m-wrap m-hero-inner">
          <div>
            <p className="eyebrow">Train booking, rerouted</p>
            <h1 className="m-title">Stop watching waitlists. Get a confirmed seat.</h1>
            <p className="m-sub">
              Reroute searches combinations of trains between any two stations, ranks them by how likely you are to get a seat, and books the best one for you.
            </p>
            <div className="m-actions">
              <Link href={ROUTES.signup.href} className="button">
                Get started free
              </Link>
              <Link href={ROUTES.book.href} className="button secondary">
                Try a search
              </Link>
            </div>
          </div>
          <RouteVisual />
        </div>
      </section>

      <section id="features" className="m-section">
        <div className="m-wrap">
          <p className="eyebrow">Features</p>
          <h2 className="m-h2">Everything between “search” and “seat”</h2>
          <div className="m-grid">
            {FEATURES.map((f) => (
              <article key={f.tag} className="m-card cad">
                <span className="m-card-tag">{f.tag}</span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="m-section m-section-alt">
        <div className="m-wrap">
          <p className="eyebrow">How it works</p>
          <h2 className="m-h2">Three steps</h2>
          <ol className="m-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="m-step-n">{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="faq" className="m-section">
        <div className="m-wrap m-faq">
          <div>
            <p className="eyebrow">FAQ</p>
            <h2 className="m-h2">Questions</h2>
          </div>
          <div>
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="m-section m-final">
        <div className="m-wrap">
          <h2 className="m-h2">Your next trip, confirmed.</h2>
          <Link href={ROUTES.signup.href} className="button button-accent">
            Create your account
          </Link>
        </div>
      </section>
    </>
  );
}
