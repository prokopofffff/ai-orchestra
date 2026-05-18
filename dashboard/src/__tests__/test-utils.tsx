import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectProvider } from "../contexts/ProjectContext";
import * as api from "../api";
import { vi } from "vitest";

/**
 * Render a component wrapped in a fresh QueryClientProvider + ProjectProvider.
 * Each test gets its own client so cache state doesn't bleed across tests.
 *
 * ProjectProvider needs api.fetchProjects mocked — components reading
 * useProjectContext (e.g. AutoMergeToggle in the chat header) blow up
 * otherwise. We default it to [] so tests that don't care about projects
 * still pass; tests that DO can override with vi.mocked(api.fetchProjects)
 * before render.
 */
export function renderWithQuery(ui: ReactElement) {
  if (vi.isMockFunction(api.fetchProjects)) {
    const mocked = vi.mocked(api.fetchProjects);
    if (mocked.getMockImplementation() == null) {
      mocked.mockResolvedValue([]);
    }
  }
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,          // fail fast in tests
        refetchInterval: false, // no polling in tests
        staleTime: Infinity,   // don't refetch on mount
      },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectProvider>{ui}</ProjectProvider>
    </QueryClientProvider>,
  );
}
