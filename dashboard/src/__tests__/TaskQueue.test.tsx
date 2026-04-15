import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { TaskQueue } from "../components/TaskQueue";
import * as api from "../api";
import { renderWithQuery } from "./test-utils";

vi.mock("../api");

beforeEach(() => vi.resetAllMocks());

describe("TaskQueue", () => {
  it("renders nothing until the query resolves", () => {
    vi.mocked(api.fetchQueueStatus).mockImplementation(() => new Promise(() => {}));
    const { container } = renderWithQuery(<TaskQueue />);
    expect(container.firstChild).toBeNull();
  });

  it("shows queued / running / completed / failed counts", async () => {
    vi.mocked(api.fetchQueueStatus).mockResolvedValue({
      rateLimited: false,
      rateLimitResetTime: null,
      queued: 3, running: 1, completed: 42, failed: 2,
    });
    renderWithQuery(<TaskQueue />);

    await screen.findByText("Queue Status");
    // Each stat appears with its label next to the value.
    const expect_pair = (value: string, label: string) => {
      const node = screen.getByText(label);
      const stat = node.closest(".stat")!;
      expect(stat.textContent).toContain(value);
    };
    expect_pair("3",  "Queued");
    expect_pair("1",  "Running");
    expect_pair("42", "Completed");
    expect_pair("2",  "Failed");
  });

  it("renders the rate-limited banner when rateLimited = true", async () => {
    vi.mocked(api.fetchQueueStatus).mockResolvedValue({
      rateLimited: true,
      rateLimitResetTime: "2026-04-14T12:00:00Z",
      queued: 0, running: 0, completed: 0, failed: 0,
    });
    renderWithQuery(<TaskQueue />);
    await screen.findByText(/Rate limited/);
  });

  it("hides the rate-limited banner when rateLimited = false", async () => {
    vi.mocked(api.fetchQueueStatus).mockResolvedValue({
      rateLimited: false,
      rateLimitResetTime: null,
      queued: 0, running: 0, completed: 0, failed: 0,
    });
    renderWithQuery(<TaskQueue />);
    await screen.findByText("Queue Status");
    expect(screen.queryByText(/Rate limited/)).toBeNull();
  });
});
