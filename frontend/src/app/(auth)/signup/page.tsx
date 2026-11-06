import type { Metadata } from "next";
import { SignInPage } from "@/components/SignInPage";

export const metadata: Metadata = { title: "Create account" };

export default function Page() {
  return <SignInPage mode="signup" />;
}
