"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { APP_NAV, LANDING_NAV, ROUTES } from "@/config/routes";
import { fetchProfile } from "@/lib/api";

export function MarketingNav() {
  const [signedIn, setSignedIn] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    void fetchProfile().then((p) => current && setSignedIn(Boolean(p)));
    return () => {
      current = false;
    };
  }, []);

  return (
    <header className="m-nav">
      <div className="m-wrap m-nav-inner">
        <Link href={ROUTES.landing.href} className="brand">
          Reroute
        </Link>
        <button type="button" className="m-burger secondary" aria-expanded={open} aria-controls="m-menu" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Menu"}
        </button>
        <div id="m-menu" className={`m-menu${open ? " is-open" : ""}`}>
          <nav aria-label="Page sections">
            {LANDING_NAV.map(({ href, label }) => (
              <a key={href} href={href} onClick={() => setOpen(false)}>
                {label}
              </a>
            ))}
          </nav>
          <div className="m-cta">
            {signedIn ? (
              <Link href={ROUTES.home.href} className="button">
                Open app
              </Link>
            ) : (
              <>
                <Link href={ROUTES.signin.href} className="m-signin">
                  Sign in
                </Link>
                <Link href={ROUTES.signup.href} className="button">
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="m-footer">
      <div className="m-wrap m-footer-inner">
        <div>
          <Link href={ROUTES.landing.href} className="brand">
            Reroute
          </Link>
          <p>Confirmed train seats across India, found by routing around full trains.</p>
        </div>
        <nav aria-label="Product">
          <h3>Product</h3>
          {APP_NAV.filter((r) => r.href !== ROUTES.home.href).map(({ href, label }) => (
            <Link key={href} href={href}>
              {label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Account">
          <h3>Account</h3>
          <Link href={ROUTES.signin.href}>Sign in</Link>
          <Link href={ROUTES.signup.href}>Create account</Link>
        </nav>
      </div>
      <div className="m-wrap m-footer-base">© {new Date().getFullYear()} Reroute</div>
    </footer>
  );
}
