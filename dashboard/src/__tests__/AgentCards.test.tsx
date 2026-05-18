import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { AgentCards } from "../components/AgentCards";
import * as api from "../api";
import type { AgentSession } from "../types";
import { renderWithQuery } from "./test-utils";

vi.mock("../api");

function sess(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: "s-" + Math.random().toString(36).slice(2, 10),
    projectId: "p1",
    role: "backend",
    taskId: null,
    claudeSessionId: null,
    status: "running",
    model: "sonnet",
    worktreePath: null,
    lastHeartbeat: null,
    startedAt: new Date("2026-04-14T10:00:00Z"),
    finishedAt: null,
    ...overrides,
  };
}

beforeEach(() => vi.resetAllMocks());

describe("AgentCards", () => {
  it("renders the empty state when there are no sessions", async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue([]);
    renderWithQuery(<AgentCards projectId="p1" />);
    await screen.findByText(/Нет активных агентов/);
  });

  it("renders one card per session with role, model, status", async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue([
      sess({ role: "backend",  model: "sonnet", status: "running" }),
      sess({ role: "frontend", model: "opus",   status: "sleeping" }),
    ]);
    renderWithQuery(<AgentCards projectId="p1" />);
    await screen.findByText("Активные агенты");

    expect(screen.getByText("backend")).toBeInTheDocument();
    expect(screen.getByText("frontend")).toBeInTheDocument();
    expect(screen.getByText("sonnet")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("sleeping")).toBeInTheDocument();
  });

  it("applies status-* class to each card", async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue([
      sess({ status: "running" }),
      sess({ status: "crashed" }),
    ]);
    renderWithQuery(<AgentCards projectId="p1" />);
    await screen.findByText("Активные агенты");

    const runCard = screen.getByText("running").closest(".agent-card")!;
    const crashCard = screen.getByText("crashed").closest(".agent-card")!;
    expect(runCard.classList.contains("status-running")).toBe(true);
    expect(crashCard.classList.contains("status-crashed")).toBe(true);
  });

  it("renders worktree path (shortened) when present", async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue([
      sess({ worktreePath: "/Users/x/orchestra-workspaces/my-proj/worktrees/feature-backend-42" }),
    ]);
    renderWithQuery(<AgentCards projectId="p1" />);
    // The `~/` prefix-strip puts the shortened tail in a visible div.
    await screen.findByText(/~\/my-proj\/worktrees\/feature-backend-42/);
  });
});
