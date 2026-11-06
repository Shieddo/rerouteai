import Link from "next/link";
import { ROUTES } from "@/config/routes";

// Split-screen shell for sign-in / sign-up: brand panel on the left, form on the right.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <Link href={ROUTES.landing.href} className="brand brand-light">
          Reroute
        </Link>
        <div>
          <p className="eyebrow eyebrow-light">Confirmed seats, not waitlists</p>
          <h2>When one train is full, we find the next best route.</h2>
          <ul className="auth-points">
            <li>Splits journeys across trains to get you a confirmed seat</li>
            <li>Auto-book with a fare cap and berth preference</li>
            <li>An assistant that can search and book in plain English</li>
          </ul>
        </div>
        <p className="auth-aside-foot">© Reroute</p>
      </aside>
      <main className="auth-main">
        <Link href={ROUTES.landing.href} className="auth-back">
          ← Back to home
        </Link>
        {children}
      </main>
    </div>
  );
}
