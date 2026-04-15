import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentLogs } from "../components/AgentLogs";
import { renderWithQuery } from "./test-utils";

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; stub it.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchLogs(logs: Array<Partial<{
  id: string; role: string; level: string; message: string; createdAt: string;
}>>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => logs.map((l, i) => ({
      id: l.id ?? `log-${i}`,
      projectId: "p1",
      sessionId: null,
      role: l.role ?? "backend",
      level: l.level ?? "stdout",
      message: l.message ?? "m",
      createdAt: l.createdAt ?? "2026-04-14T10:00:00Z",
      __url: url, // captured so tests can assert query string shape
    })),
  }));
  // @ts-expect-error — jsdom fetch is loose-typed
  globalThis.fetch = spy;
  return spy;
}

describe("AgentLogs", () => {
  it("renders logs in chronological order (reversed from DESC API)", async () => {
    mockFetchLogs([
      { id: "newest", role: "qa",      message: "THREE", createdAt: "2026-04-14T10:02:00Z" },
      { id: "mid",    role: "backend", message: "TWO",   createdAt: "2026-04-14T10:01:00Z" },
      { id: "oldest", role: "backend", message: "ONE",   createdAt: "2026-04-14T10:00:00Z" },
    ]);
    renderWithQuery(<AgentLogs projectId="p1" />);

    await screen.findByText("ONE");
    const entries = document.querySelectorAll(".log-entry .log-message");
    expect(entries[0].textContent).toBe("ONE");
    expect(entries[1].textContent).toBe("TWO");
    expect(entries[2].textContent).toBe("THREE");
  });

  it("renders an empty-state when no logs are returned", async () => {
    mockFetchLogs([]);
    renderWithQuery(<AgentLogs projectId="p1" />);
    await screen.findByText(/No logs yet/);
  });

  it("tags each entry with level-* class for stderr/error highlighting", async () => {
    mockFetchLogs([
      { id: "a", level: "stdout", message: "out" },
      { id: "b", level: "error",  message: "boom" },
    ]);
    renderWithQuery(<AgentLogs projectId="p1" />);
    await screen.findByText("boom");
    const errEntry = screen.getByText("boom").closest(".log-entry")!;
    expect(errEntry.classList.contains("level-error")).toBe(true);
  });

  it("passes role filter through to the API query string", async () => {
    const spy = mockFetchLogs([]);
    const user = userEvent.setup();
    renderWithQuery(<AgentLogs projectId="p1" />);

    // Wait for initial fetch, then change filter
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [roleSelect] = screen.getAllByRole("combobox");
    await user.selectOptions(roleSelect, "backend");

    await waitFor(() => {
      const lastUrl = spy.mock.calls.at(-1)![0] as string;
      expect(lastUrl).toContain("role=backend");
    });
  });

  it("passes level filter through to the API query string", async () => {
    const spy = mockFetchLogs([]);
    const user = userEvent.setup();
    renderWithQuery(<AgentLogs projectId="p1" />);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const selects = screen.getAllByRole("combobox");
    await user.selectOptions(selects[1], "stderr");

    await waitFor(() => {
      const lastUrl = spy.mock.calls.at(-1)![0] as string;
      expect(lastUrl).toContain("level=stderr");
    });
  });

  it("toggles auto-scroll via the checkbox", async () => {
    mockFetchLogs([]);
    const user = userEvent.setup();
    renderWithQuery(<AgentLogs projectId="p1" />);
    await screen.findByText(/Auto-scroll/);
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });
});
