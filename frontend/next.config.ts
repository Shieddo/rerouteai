import type { NextConfig } from "next";

// The Bun/Express API keeps owning auth, sessions and data. The browser only ever talks to this
// origin, so the session cookie stays first-party and the backend's same-origin CSRF check holds.
// For that check to pass in dev, run the backend with BASE_URL=http://localhost:3000.
const backend = (process.env.BACKEND_URL ?? "http://localhost:8000").replace(/\/+$/, "");

const config: NextConfig = {
  // Hide the floating Next.js logo/badge that dev mode draws over the page.
  devIndicators: false,
  async rewrites() {
    return ["auth", "trains", "stations", "journeys", "profile", "me", "plan", "bookings", "chat"].flatMap((prefix) => [
      { source: `/${prefix}`, destination: `${backend}/${prefix}` },
      { source: `/${prefix}/:path*`, destination: `${backend}/${prefix}/:path*` },
    ]);
  },
};

export default config;
