"use client";

import { useEffect, useState } from "react";
import { AuthCard, type Mode } from "@/components/AuthPrompt";
import { safeNext } from "@/config/routes";
import { fetchProfile } from "@/lib/api";

/** Shared by /signin and /signup. Already-signed-in visitors are sent straight on. */
export function SignInPage({ mode = "signin" }: { mode?: Mode }) {
  // Read ?next= after mount so the static page needs no search-params boundary.
  const [next, setNext] = useState<string | undefined>(undefined);
  useEffect(() => {
    const target = safeNext(new URLSearchParams(window.location.search).get("next"));
    setNext(target);
    void fetchProfile().then((profile) => profile && window.location.assign(target));
  }, []);
  return <AuthCard mode={mode} next={next} />;
}
