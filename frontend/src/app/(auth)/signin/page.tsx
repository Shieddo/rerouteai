import type { Metadata } from "next";
import { SignInPage } from "@/components/SignInPage";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
  return <SignInPage mode="signin" />;
}
