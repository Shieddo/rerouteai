import { MarketingFooter, MarketingNav } from "@/components/marketing/Chrome";

// Shell for public, full-width pages (landing and any future about/pricing pages).
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <MarketingNav />
      <main>{children}</main>
      <MarketingFooter />
    </>
  );
}
