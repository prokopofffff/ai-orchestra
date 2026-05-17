import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateForms } from "../components/CreateForms";
import { ProjectProvider } from "../contexts/ProjectContext";
import * as api from "../api";
import type { Project, Task } from "../types";
import type { ReactNode } from "react";

vi.mock("../api");

beforeEach(() => {
  vi.resetAllMocks();
  // ProjectProvider mounts a useQuery on /projects — give it a stable
  // empty list so tests don't see a hanging "loading" or hit the
  // unmocked api.fetchProjects.
  vi.mocked(api.fetchProjects).mockResolvedValue([]);
});

/** Wrap CreateForms in the context plumbing it now requires (ProjectContext
 *  → QueryClient). Each test gets a fresh QueryClient so cache state doesn't
 *  bleed across cases. */
function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectProvider>{ui}</ProjectProvider>
    </QueryClientProvider>,
  );
}

const fakeProject: Project = {
  id: "p1", name: "P", slug: "p", repoUrl: null, localPath: null, description: null,
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
    wrap(<CreateForms projectId="" onCreated={() => {}} />);
    expect(screen.getByRole("button", { name: "+ Project" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Task" })).toBeNull();
  });

  it("renders + Task when projectId is provided", () => {
    wrap(<CreateForms projectId="p1" onCreated={() => {}} />);
    expect(screen.getByRole("button", { name: "+ Task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Project" })).toBeInTheDocument();
  });

  it("toggles the project form on + Project click", async () => {
    const user = userEvent.setup();
    wrap(<CreateForms projectId="p1" onCreated={() => {}} />);
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
    wrap(<CreateForms projectId="" onCreated={onCreated} />);

    await user.click(screen.getByRole("button", { name: "+ Project" }));
    await user.type(screen.getByPlaceholderText("Project name"), "My Project");
    await user.type(screen.getByPlaceholderText(/Local path/), "/Users/you/myapp");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({
      name: "My Project",
      localPath: "/Users/you/myapp",
    }));
    expect(onCreated).toHaveBeenCalled();
  });

  it("omits localPath when left empty", async () => {
    vi.mocked(api.createProject).mockResolvedValue(fakeProject);
    const user = userEvent.setup();
    wrap(<CreateForms projectId="" onCreated={() => {}} />);

    await user.click(screen.getByRole("button", { name: "+ Project" }));
    await user.type(screen.getByPlaceholderText("Project name"), "Bare");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({
      name: "Bare",
      localPath: undefined,
    }));
  });

  it("creates a task with selected type/priority/assignee", async () => {
    vi.mocked(api.createTask).mockResolvedValue(fakeTask);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    wrap(<CreateForms projectId="p1" onCreated={onCreated} />);

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
    wrap(<CreateForms projectId="p1" onCreated={() => {}} />);

    await user.click(screen.getByRole("button", { name: "+ Task" }));
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    expect(api.createTask).not.toHaveBeenCalled();
  });
});
