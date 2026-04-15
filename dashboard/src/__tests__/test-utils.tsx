import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Render a component wrapped in a fresh QueryClientProvider. Each test gets
 * its own client so cache state doesn't bleed across tests.
 */
export function renderWithQuery(ui: ReactElement) {
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
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}
