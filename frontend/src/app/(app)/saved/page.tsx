import type { Metadata } from "next";
import { SavedJourneys } from "@/components/SavedJourneys";

export const metadata: Metadata = { title: "Saved journeys · Reroute" };

export default function Page() {
  return <SavedJourneys />;
}
