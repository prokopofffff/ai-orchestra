import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type { OnboardingTabKey } from "../api";
import { Tour } from "./Tour";
import { TOURS } from "./tours";

const TAB_BY_PATH: Record<string, OnboardingTabKey> = {
  "/kanban": "kanban",
  "/chat": "chat",
  "/signals": "signals",
  "/agents": "agents",
  "/flow": "flow",
  "/logs": "logs",
  "/settings": "settings",
  "/profile": "profile",
};

function routeKey(pathname: string): OnboardingTabKey | null {
  // Top-level route only — /settings?tab=members still resolves to settings.
  const top = "/" + pathname.split("/").filter(Boolean)[0];
  return TAB_BY_PATH[top] ?? null;
}

// ─── Context — TopBar's help button reaches in via this ───

type TourCtx = { open: () => void; available: boolean };
const TourContext = createContext<TourCtx>({ open: () => {}, available: false });
export function useRouteTour() { return useContext(TourContext); }

/**
 * Mounted once in AppShell. Two responsibilities:
 *
 *   - auto-open the coachmark tour the first time the user lands on each
 *     route (route key not yet in onboarding.tabsSeen);
 *   - expose `open()` via React context so the TopBar `?` button can
 *     re-trigger the tour for the current route any time.
 *
 * Completion + skip both mark the route as seen on the server so the
 * auto-trigger fires at most once per user per tab.
 */
export function TourHost({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [openFor, setOpenFor] = useState<OnboardingTabKey | null>(null);

  const { data } = useQuery({
    queryKey: ["onboarding"],
    queryFn: api.fetchOnboarding,
    // No refetch interval — onboarding state changes rarely and we
    // invalidate explicitly after dismiss / welcome-seen / tab-seen.
  });

  const tab = routeKey(location.pathname);
  const steps = tab ? TOURS[tab] : null;
  const seen = data?.tabsSeen ?? [];

  // Auto-open on first visit to a route not yet seen. Delay a tick so the
  // anchor elements have time to mount on the new page; without this the
  // first step's anchor is still null and we'd render uncentered.
  useEffect(() => {
    if (!tab || !steps || steps.length === 0) return;
    if (!data) return;
    if (seen.includes(tab)) return;
    const t = setTimeout(() => setOpenFor(tab), 150);
    return () => clearTimeout(t);
  }, [tab, data, steps, seen]);

  const open = useCallback(() => {
    if (tab) setOpenFor(tab);
  }, [tab]);

  async function close() {
    if (openFor) {
      try {
        await api.markTabSeen(openFor);
        await queryClient.invalidateQueries({ queryKey: ["onboarding"] });
      } catch {
        // Best-effort: if the network fails the user just sees the tour
        // again next visit. Not worth retrying inline.
      }
    }
    setOpenFor(null);
  }

  const ctx: TourCtx = { open, available: Boolean(tab && steps && steps.length > 0) };

  return (
    <TourContext.Provider value={ctx}>
      {children}
      {openFor && steps && (
        <Tour open steps={steps} onClose={close} />
      )}
    </TourContext.Provider>
  );
}
