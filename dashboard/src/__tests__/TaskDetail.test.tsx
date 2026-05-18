import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetail } from "../components/TaskDetail";
import * as api from "../api";
import type { Task, TaskComment } from "../types";
import { renderWithQuery } from "./test-utils";

vi.mock("../api");

function task(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    projectId: "p1",
    parentId: null,
    title: "Implement login",
    description: "Add OAuth flow",
    type: "task",
    state: "in_development",
    priority: "normal",
    assigneeRole: "backend",
    blockedBy: [],
    branchName: "feature/backend/login",
    prUrl: null,
    createdAt: new Date("2026-04-14T10:00:00Z"),
    updatedAt: new Date("2026-04-14T10:00:00Z"),
    ...overrides,
  };
}

function comment(overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: "c-" + Math.random().toString(36).slice(2, 10),
    taskId: "t1",
    author: "tech-lead",
    body: "Looks good",
    createdAt: new Date("2026-04-14T10:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => vi.resetAllMocks());

describe("TaskDetail", () => {
  it("renders nothing while the task query is pending", () => {
    vi.mocked(api.fetchTask).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.fetchComments).mockResolvedValue([]);
    const { container } = renderWithQuery(<TaskDetail taskId="t1" onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the task title + branch + fields after load", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task({}));
    vi.mocked(api.fetchComments).mockResolvedValue([]);
    renderWithQuery(<TaskDetail taskId="t1" onClose={() => {}} />);

    expect(await screen.findByText("Implement login")).toBeInTheDocument();
    expect(screen.getByText("feature/backend/login")).toBeInTheDocument();
  });

  it("calls updateTask + invalidates when state select changes", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task({}));
    vi.mocked(api.fetchComments).mockResolvedValue([]);
    vi.mocked(api.updateTask).mockResolvedValue(task({}));
    const user = userEvent.setup();

    renderWithQuery(<TaskDetail taskId="t1" onClose={() => {}} />);
    await screen.findByText("Implement login");

    // First combobox is the state select
    await user.selectOptions(screen.getAllByRole("combobox")[0], "pr_created");

    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith("t1", { state: "pr_created" }));
  });

  it("updates priority via the priority select", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task({}));
    vi.mocked(api.fetchComments).mockResolvedValue([]);
    vi.mocked(api.updateTask).mockResolvedValue(task({}));
    const user = userEvent.setup();

    renderWithQuery(<TaskDetail taskId="t1" onClose={() => {}} />);
    await screen.findByText("Implement login");

    // Priority is the 2nd combobox (state, priority, assignee, type)
    await user.selectOptions(screen.getAllByRole("combobox")[1], "high");
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith("t1", { priority: "high" }));
  });

  it("lists existing comments", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task({}));
    vi.mocked(api.fetchComments).mockResolvedValue([
      comment({ author: "tech-lead", body: "TL note" }),
      comment({ author: "backend",   body: "dev question" }),
    ]);
    renderWithQuery(<TaskDetail taskId="t1" onClose={() => {}} />);

    expect(await screen.findByText("TL note")).toBeInTheDocument();
    expect(screen.getByText("dev question")).toBeInTheDocument();
    expect(screen.getByText("Комментарии (2)")).toBeInTheDocument();
  });

  it("adds a comment and clears the input", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task({}));
    vi.mocked(api.fetchComments).mockResolvedValue([]);
    vi.mocked(api.addComment).mockResolvedValue(comment({ body: "new one" }));
    const user = userEvent.setup();

    renderWithQuery(<TaskDetail taskId="t1" onClose={() => {}} />);
    await screen.findByText("Implement login");

    const input = screen.getByPlaceholderText(/Добавить комментарий/);
    await user.type(input, "new one");
    await user.click(screen.getByRole("button", { name: "Отправить" }));

    await waitFor(() => expect(api.addComment).toHaveBeenCalledWith("t1", "user", "new one"));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("delete prompts for confirmation — no delete when cancelled", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task({}));
    vi.mocked(api.fetchComments).mockResolvedValue([]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();

    renderWithQuery(<TaskDetail taskId="t1" onClose={() => {}} />);
    await screen.findByText("Implement login");

    await user.click(screen.getByRole("button", { name: "Удалить задачу" }));
    expect(api.deleteTask).not.toHaveBeenCalled();
  });

  it("delete proceeds + closes when confirmed", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task({}));
    vi.mocked(api.fetchComments).mockResolvedValue([]);
    vi.mocked(api.deleteTask).mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithQuery(<TaskDetail taskId="t1" onClose={onClose} />);
    await screen.findByText("Implement login");

    await user.click(screen.getByRole("button", { name: "Удалить задачу" }));
    await waitFor(() => expect(api.deleteTask).toHaveBeenCalledWith("t1"));
    expect(onClose).toHaveBeenCalled();
  });

  it("backdrop click closes the modal; content click does not", async () => {
    vi.mocked(api.fetchTask).mockResolvedValue(task({}));
    vi.mocked(api.fetchComments).mockResolvedValue([]);
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithQuery(<TaskDetail taskId="t1" onClose={onClose} />);
    await screen.findByText("Implement login");

    // Click inside modal content first — should NOT close
    await user.click(screen.getByText("Implement login"));
    expect(onClose).not.toHaveBeenCalled();

    // Click backdrop
    const backdrop = document.querySelector(".modal-overlay")!;
    await user.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
