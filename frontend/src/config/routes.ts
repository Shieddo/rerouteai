// Single source of truth for navigation. To add a page:
//   1. create `src/app/(group)/<path>/page.tsx` (use `(app)` for signed-in pages, `(marketing)` for public ones),
//   2. add one entry below. The header, landing nav and footer all read from here.

export type RouteArea = "app" | "marketing" | "auth";

export type RouteEntry = {
  href: string;
  label: string;
  area: RouteArea;
  /** Short blurb used on the home dashboard and landing cards. */
  description?: string;
};

export const ROUTES = {
  landing: { href: "/", label: "Reroute", area: "marketing" },
  signin: { href: "/signin", label: "Sign in", area: "auth" },
  signup: { href: "/signup", label: "Create account", area: "auth" },
  home: { href: "/home", label: "Home", area: "app", description: "Your trips and shortcuts at a glance." },
  book: { href: "/book", label: "Book tickets", area: "app", description: "Search, compare and book confirmed seats." },
  bookings: { href: "/my-bookings", label: "My bookings", area: "app", description: "PNRs, status, refunds and cancellations." },
  search: { href: "/search", label: "Explore routes", area: "app", description: "Discover multi-train route combinations." },
  saved: { href: "/saved", label: "Saved", area: "app", description: "Journeys you bookmarked for later." },
} as const satisfies Record<string, RouteEntry>;

/** Links shown in the signed-in app header, in order. Add new app routes here. */
export const APP_NAV: RouteEntry[] = [ROUTES.home, ROUTES.book, ROUTES.bookings, ROUTES.search, ROUTES.saved];

/** Anchors on the landing page, shown in the marketing nav. */
export const LANDING_NAV = [
  { href: "/#features", label: "Features" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#faq", label: "FAQ" },
];

/** Where people land after signing in. */
export const AFTER_SIGN_IN = ROUTES.home.href;

/** Only same-site paths are allowed as post-auth redirects (blocks open redirects). */
export const safeNext = (next?: string | null) => (next && next.startsWith("/") && !next.startsWith("//") ? next : AFTER_SIGN_IN);
