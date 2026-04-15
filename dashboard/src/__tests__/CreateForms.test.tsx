import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateForms } from "../components/CreateForms";
import * as api from "../api";
import type { Project, Task } from "../types";

vi.mock("../api");

beforeEach(() => vi.resetAllMocks());

const fakeProject: Project = {
  id: "p1", name: "P", slug: "p", repoUrl: null, description: null,
  settings: {}, createdAt: new Date(), updatedAt: new Date(),
};

const fakeTask: Task = {
  id: "t1", projectId: "p1", parentId: null, title: "T", description: null,
  type: "task", state: "new", priority: "normal", assigneeRole: null,
  blockedBy: [], branchName: null, prUrl: null,
  createdAt: new Date(), updatedAt: new Date(),
};

describe("CreateForms", () => {
  it("renders only + Project when no projectId is provided", () => {
    render(<CreateForms projectId="" onCreated={() => {}} />);
    expect(screen.getByRole("button", { name: "+ Project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Task" })).toBeNull();
  });

  it("renders + Task when projectId is provided", () => {
    render(<CreateForms projectId="p1" onCreated={() => {}} />);
    expect(screen.getByRole("button", { name: "+ Task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Project" })).toBeInTheDocument();
  });

  it("toggles the project form on + Project click", async () => {
    const user = userEvent.setup();
    render(<CreateForms projectId="p1" onCreated={() => {}} />);
    expect(screen.queryByPlaceholderText("Project name")).toBeNull();

    await user.click(screen.getByRole("button", { name: "+ Project" }));
    expect(screen.getByPlaceholderText("Project name")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ Project" }));
    expect(screen.queryByPlaceholderText("Project name")).toBeNull();
  });

  it("creates a project on submit and calls onCreated", async () => {
    vi.mocked(api.createProject).mockResolvedValue(fakeProject);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<CreateForms projectId="" onCreated={onCreated} />);

    await user.click(screen.getByRole("button", { name: "+ Project" }));
    await user.type(screen.getByPlaceholderText("Project name"), "My Project");
    await user.type(screen.getByPlaceholderText(/Repo URL/), "https://github.com/o/r");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({
      name: "My Project",
      repoUrl: "https://github.com/o/r",
    }));
    expect(onCreated).toHaveBeenCalled();
  });

  it("omits repoUrl when left empty", async () => {
    vi.mocked(api.createProject).mockResolvedValue(fakeProject);
    const user = userEvent.setup();
    render(<CreateForms projectId="" onCreated={() => {}} />);

    await user.click(screen.getByRole("button", { name: "+ Project" }));
    await user.type(screen.getByPlaceholderText("Project name"), "Bare");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({
      name: "Bare",
      repoUrl: undefined,
    }));
  });

  it("creates a task with selected type/priority/assignee", async () => {
    vi.mocked(api.createTask).mockResolvedValue(fakeTask);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<CreateForms projectId="p1" onCreated={onCreated} />);

    await user.click(screen.getByRole("button", { name: "+ Task" }));
    await user.type(screen.getByPlaceholderText("Task title"), "Fix bug");

    const selects = screen.getAllByRole("combobox");
    // Order: type, priority, assignee
    await user.selectOptions(selects[0], "bug");
    await user.selectOptions(selects[1], "high");
    await user.selectOptions(selects[2], "backend");

    await user.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith({
      projectId: "p1",
      title: "Fix bug",
      type: "bug",
      priority: "high",
      assigneeRole: "backend",
    }));
    expect(onCreated).toHaveBeenCalled();
  });

  it("does not submit an empty task title", async () => {
    const user = userEvent.setup();
    render(<CreateForms projectId="p1" onCreated={() => {}} />);

    await user.click(screen.getByRole("button", { name: "+ Task" }));
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    expect(api.createTask).not.toHaveBeenCalled();
  });
});
