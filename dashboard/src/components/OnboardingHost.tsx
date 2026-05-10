import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { OnboardingChecklist } from "./OnboardingChecklist";
import { WelcomeModal } from "./WelcomeModal";
import { useState, useEffect } from "react";

/**
 * Single mounting point for both the welcome modal and the checklist
 * widget — sits in AppShell so it's visible on every authenticated route.
 *
 * Renders nothing until /onboarding responds. Welcome shown once per
 * fresh signup (server gates on `showWelcome`); the floating checklist
 * stays in the bottom-right corner until dismissed or all steps satisfied.
 */
export function OnboardingHost() {
  const { data } = useQuery({
    queryKey: ["onboarding"],
    queryFn: api.fetchOnboarding,
    refetchInterval: 30_000,
  });
  const [welcomeOpen, setWelcomeOpen] = useState(false);

  useEffect(() => {
    if (data?.showWelcome) setWelcomeOpen(true);
  }, [data?.showWelcome]);

  if (!data) return null;
  return (
    <>
      {welcomeOpen && <WelcomeModal onClose={() => setWelcomeOpen(false)} />}
      <div className="onboarding-floating fixed bottom-6 right-6 z-40 w-[340px] max-w-[calc(100vw-3rem)]">
        <OnboardingChecklist />
      </div>
    </>
  );
}
