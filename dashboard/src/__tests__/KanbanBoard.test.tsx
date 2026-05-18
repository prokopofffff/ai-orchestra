import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KanbanBoard } from "../components/KanbanBoard";
import * as api from "../api";
import type { Task } from "../types";
import { renderWithQuery } from "./test-utils";

vi.mock("../api");

function task(overrides: Partial<Task>): Task {
  return {
    id: "t-" + Math.random().toString(36).slice(2, 10),
    projectId: "p1",
    parentId: null,
    title: "Sample",
    description: null,
    type: "task",
    state: "new",
    priority: "normal",
    assigneeRole: null,
    blockedBy: [],
    branchName: null,
    prUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => vi.resetAllMocks());

describe("KanbanBoard", () => {
  it("shows a loading state while the query resolves", async () => {
    vi.mocked(api.fetchTasks).mockImplementation(() => new Promise(() => {})); // never resolves
    renderWithQuery(<KanbanBoard projectId="p1" onTaskClick={() => {}} />);
    expect(screen.getByText(/Загрузка задач/)).toBeInTheDocument();
  });

  it("renders every phase, even empty ones (count = 0)", async () => {
    vi.mocked(api.fetchTasks).mockResolvedValue([]);
    renderWithQuery(<KanbanBoard projectId="p1" onTaskClick={() => {}} />);
    await screen.findByText("Бэклог");
    for (const phase of ["Бэклог", "Дизайн", "Разработка", "Тестирование", "Ревью", "Готово", "Заблокировано"]) {
      expect(screen.getByText(phase)).toBeInTheDocument();
    }
  });

  it("routes a task into the phase its state belongs to", async () => {
    vi.mocked(api.fetchTasks).mockResolvedValue([
      task({ title: "New One",   state: "new" }),
      task({ title: "Dev One",   state: "in_development" }),
      task({ title: "Merged One", state: "merged" }),
    ]);
    renderWithQuery(<KanbanBoard projectId="p1" onTaskClick={() => {}} />);
    const newCard = await screen.findByText("New One");
    const devCard = await screen.findByText("Dev One");
    const mergedCard = await screen.findByText("Merged One");

    // Each card sits inside a kanban-column — walk up and check the column header.
    expect(newCard.closest(".kanban-column")!.querySelector("h3")!.textContent).toMatch(/Бэклог/);
    expect(devCard.closest(".kanban-column")!.querySelector("h3")!.textContent).toMatch(/Разработка/);
    expect(mergedCard.closest(".kanban-column")!.querySelector("h3")!.textContent).toMatch(/Готово/);
  });

  it("renders assignee role chip when set", async () => {
    vi.mocked(api.fetchTasks).mockResolvedValue([
      task({ title: "Backend Task", assigneeRole: "backend" }),
    ]);
    renderWithQuery(<KanbanBoard projectId="p1" onTaskClick={() => {}} />);
    expect(await screen.findByText("backend")).toBeInTheDocument();
  });

  it("marks a task as blocked when any blocker is unfinished", async () => {
    const blocker = task({ title: "Blocker", state: "in_development" });
    const blocked = task({ title: "Dependent", blockedBy: [blocker.id] });
    vi.mocked(api.fetchTasks).mockResolvedValue([blocker, blocked]);

    renderWithQuery(<KanbanBoard projectId="p1" onTaskClick={() => {}} />);
    await screen.findByText("Dependent");
    const card = screen.getByText("Dependent").closest(".kanban-card")!;
    expect(card.classList.contains("blocked")).toBe(true);
    expect(card.querySelector(".card-blocked")).toBeTruthy();
  });

  it("does not mark blocked when all blockers are merged or closed", async () => {
    const blocker = task({ title: "Done Blocker", state: "merged" });
    const dependent = task({ title: "Freed", blockedBy: [blocker.id] });
    vi.mocked(api.fetchTasks).mockResolvedValue([blocker, dependent]);

    renderWithQuery(<KanbanBoard projectId="p1" onTaskClick={() => {}} />);
    await screen.findByText("Freed");
    const card = screen.getByText("Freed").closest(".kanban-card")!;
    expect(card.classList.contains("blocked")).toBe(false);
    expect(card.querySelector(".card-blocked")).toBeNull();
  });

  it("calls onTaskClick with the task id when a card is clicked", async () => {
    const onClick = vi.fn();
    vi.mocked(api.fetchTasks).mockResolvedValue([task({ id: "task-abc", title: "Click me" })]);
    const user = userEvent.setup();

    renderWithQuery(<KanbanBoard projectId="p1" onTaskClick={onClick} />);
    await user.click(await screen.findByText("Click me"));

    await waitFor(() => expect(onClick).toHaveBeenCalledWith("task-abc"));
  });

  it("applies priority-* class to the card", async () => {
    vi.mocked(api.fetchTasks).mockResolvedValue([
      task({ title: "Urgent", priority: "immediate" }),
    ]);
    renderWithQuery(<KanbanBoard projectId="p1" onTaskClick={() => {}} />);
    const card = (await screen.findByText("Urgent")).closest(".kanban-card")!;
    expect(card.classList.contains("priority-immediate")).toBe(true);
  });
});
