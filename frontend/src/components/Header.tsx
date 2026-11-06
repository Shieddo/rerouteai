"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { APP_NAV, ROUTES } from "@/config/routes";
import { fetchProfile, signOut, type Profile } from "@/lib/api";

export function Header() {
  const pathname = usePathname();
  const [profile, setProfile] = useState<Profile | null>(null);

  // Re-check on navigation: signing in redirects back here with a fresh session cookie.
  useEffect(() => {
    let current = true;
    void fetchProfile().then((p) => current && setProfile(p));
    return () => {
      current = false;
    };
  }, [pathname]);

  async function onSignOut() {
    await signOut();
    setProfile(null);
    window.location.assign(ROUTES.landing.href);
  }

  return (
    <header className="site-header">
      <Link href={ROUTES.landing.href} className="brand">
        Reroute
      </Link>
      <nav className="tabs" aria-label="Sections">
        {APP_NAV.map(({ href, label }) => (
          <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      {!profile && (
        <div className="account">
          <Link href={`${ROUTES.signin.href}?next=${encodeURIComponent(pathname)}`} className="button secondary account-signin">
            Sign in
          </Link>
        </div>
      )}
      {profile && (
        <div className="account">
          <span>{profile.name ?? profile.email ?? "Signed in"}</span>
          <button type="button" className="secondary" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
