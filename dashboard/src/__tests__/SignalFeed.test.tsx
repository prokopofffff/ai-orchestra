import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { SignalFeed } from "../components/SignalFeed";
import * as api from "../api";
import type { AuditEntry } from "../types";
import { renderWithQuery } from "./test-utils";

vi.mock("../api");

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: "e-" + Math.random().toString(36).slice(2, 10),
    projectId: "p1",
    fromRole: "tech-lead",
    toRole: "backend",
    action: "assign_dev",
    taskId: null,
    status: "allowed",
    reason: null,
    payload: {},
    createdAt: new Date("2026-04-14T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => vi.resetAllMocks());

describe("SignalFeed", () => {
  it("shows the loading state pre-data", () => {
    vi.mocked(api.fetchAudit).mockImplementation(() => new Promise(() => {}));
    renderWithQuery(<SignalFeed projectId="p1" />);
    expect(screen.getByText(/Загрузка сигналов/)).toBeInTheDocument();
  });

  it("renders the empty state when no audit entries exist", async () => {
    vi.mocked(api.fetchAudit).mockResolvedValue([]);
    renderWithQuery(<SignalFeed projectId="p1" />);
    await screen.findByText(/Сигналов пока нет/);
  });

  it("renders one row per audit entry with action + from/to", async () => {
    vi.mocked(api.fetchAudit).mockResolvedValue([
      entry({ fromRole: "tech-lead", toRole: "backend", action: "assign_dev" }),
      entry({ fromRole: "qa", toRole: "tech-lead", action: "tests_passed" }),
    ]);
    renderWithQuery(<SignalFeed projectId="p1" />);
    await screen.findByText("Лента сигналов");

    expect(screen.getByText("assign_dev")).toBeInTheDocument();
    expect(screen.getByText("tests_passed")).toBeInTheDocument();
    // tech-lead appears twice (once as sender, once as target) — check there's at least 1 match
    expect(screen.getAllByText("tech-lead").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("backend").length).toBeGreaterThanOrEqual(1);
  });

  it("marks rejected entries with the rejected class and shows the reason", async () => {
    vi.mocked(api.fetchAudit).mockResolvedValue([
      entry({ status: "rejected", reason: "Invalid transition: new → in_development" }),
    ]);
    renderWithQuery(<SignalFeed projectId="p1" />);
    await screen.findByText(/Invalid transition/);
    const row = screen.getByText(/Invalid transition/).closest(".signal-entry")!;
    expect(row.classList.contains("rejected")).toBe(true);
  });

  it("marks allowed entries with the allowed class and hides the reason block", async () => {
    vi.mocked(api.fetchAudit).mockResolvedValue([entry({ status: "allowed" })]);
    renderWithQuery(<SignalFeed projectId="p1" />);
    await screen.findByText("assign_dev");
    const row = screen.getByText("assign_dev").closest(".signal-entry")!;
    expect(row.classList.contains("allowed")).toBe(true);
    expect(row.querySelector(".signal-reason")).toBeNull();
  });
});
