"use client";

import { useEffect, useState } from "react";
import { AuthPrompt } from "@/components/AuthPrompt";

export function SignInPage() {
  // Read ?next= after mount so the static page needs no search-params boundary.
  const [next, setNext] = useState<string | undefined>(undefined);
  useEffect(() => {
    setNext(new URLSearchParams(window.location.search).get("next") ?? "/book");
  }, []);
  return (
    <>
      <h1>Sign in to Reroute</h1>
      <p className="lede">Book confirmed seats, manage your tickets and chat with the assistant.</p>
      <AuthPrompt next={next} />
    </>
  );
}
