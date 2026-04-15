import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectChecks } from "../components/ProjectChecks";
import * as api from "../api";
import type { Project } from "../types";

vi.mock("../api");

const baseProject: Project = {
  id: "p1",
  name: "Test Project",
  slug: "test-project",
  repoUrl: null,
  description: null,
  settings: {},
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("ProjectChecks", () => {
  it("renders 'Using role default' for every role when no overrides exist", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue([baseProject]);

    render(<ProjectChecks projectId="p1" />);

    await screen.findByText(/Project Checks/);
    const usingDefault = await screen.findAllByText("Using role default.");
    // Six roles, all empty → six "default" placeholders
    expect(usingDefault).toHaveLength(6);
  });

  it("shows existing overrides from project.settings.checks with the override badge", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue([{
      ...baseProject,
      settings: {
        checks: {
          backend: [
            { name: "ci", pattern: "src/backend/**", command: "pnpm ci", onFail: "alert" },
          ],
        },
      },
    }]);

    render(<ProjectChecks projectId="p1" />);

    await screen.findByText("override");
    expect(screen.getByDisplayValue("ci")).toBeInTheDocument();
    expect(screen.getByDisplayValue("pnpm ci")).toBeInTheDocument();
    expect(screen.getByDisplayValue("alert")).toBeInTheDocument();
  });

  it("Add check appends a row scoped to that role", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue([baseProject]);
    const user = userEvent.setup();

    render(<ProjectChecks projectId="p1" />);
    await screen.findByText(/Project Checks/);

    // Each role has its own "+ Add check" button — pick the first (tech-lead).
    const addButtons = screen.getAllByRole("button", { name: "+ Add check" });
    await user.click(addButtons[0]);

    // A name input appears for the new row
    expect(screen.getByPlaceholderText("e.g. tsc")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("glob")).toBeInTheDocument();
  });

  it("Save strips empty rows and PATCHes the resolved settings", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue([baseProject]);
    vi.mocked(api.updateProject).mockResolvedValue(baseProject);
    const user = userEvent.setup();

    render(<ProjectChecks projectId="p1" />);
    await screen.findByText(/Project Checks/);

    // Add a row to the first role then leave it empty (no name/command).
    await user.click(screen.getAllByRole("button", { name: "+ Add check" })[0]);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith("p1", {
        // Empty row stripped → checks is empty
        settings: { checks: {} },
      });
    });
    await screen.findByText("Saved");
  });

  it("Save passes complete rows through and preserves other settings keys", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue([{
      ...baseProject,
      settings: { models: { backend: "opus" } }, // unrelated existing key
    }]);
    vi.mocked(api.updateProject).mockResolvedValue(baseProject);
    const user = userEvent.setup();

    render(<ProjectChecks projectId="p1" />);
    await screen.findByText(/Project Checks/);

    // Add a row and fill it in for the first role (tech-lead).
    await user.click(screen.getAllByRole("button", { name: "+ Add check" })[0]);
    await user.type(screen.getByPlaceholderText("e.g. tsc"), "tsc");
    await user.type(screen.getByPlaceholderText("pnpm exec tsc --noEmit"), "pnpm tsc");

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith("p1", {
        settings: {
          models: { backend: "opus" },
          checks: {
            "tech-lead": [
              { name: "tsc", pattern: "**/*.ts", command: "pnpm tsc", onFail: "warn" },
            ],
          },
        },
      });
    });
  });

  it("Reset removes the override for that role", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue([{
      ...baseProject,
      settings: {
        checks: {
          backend: [
            { name: "ci", pattern: "src/backend/**", command: "pnpm ci", onFail: "alert" },
          ],
        },
      },
    }]);
    vi.mocked(api.updateProject).mockResolvedValue(baseProject);
    const user = userEvent.setup();

    render(<ProjectChecks projectId="p1" />);
    await screen.findByText("override");

    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith("p1", {
        settings: { checks: {} },
      });
    });
  });
});
