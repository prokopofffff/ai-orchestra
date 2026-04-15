import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stub mermaid *before* importing FlowDiagram — the component calls
// mermaid.initialize() at module load and mermaid.render() in an effect.
// jsdom has no layout engine, so a real render would hang.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => ({ svg: `<svg data-id="${id}">stub</svg>` })),
  },
}));

import { FlowDiagram } from "../components/FlowDiagram";
import { flow } from "@ai-orchestra/shared";

beforeEach(() => vi.clearAllMocks());

describe("FlowDiagram", () => {
  it("renders the heading + toggle + canvas", () => {
    render(<FlowDiagram />);
    expect(screen.getByText("Flow")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "State Machine" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Role Graph" })).toBeInTheDocument();
  });

  it("defaults to the state-machine view (State Machine button active)", () => {
    render(<FlowDiagram />);
    const btn = screen.getByRole("button", { name: "State Machine" });
    expect(btn.classList.contains("active")).toBe(true);
  });

  it("toggles to the role graph when Role Graph is clicked", async () => {
    const user = userEvent.setup();
    render(<FlowDiagram />);
    await user.click(screen.getByRole("button", { name: "Role Graph" }));
    const active = screen.getByRole("button", { name: "Role Graph" });
    expect(active.classList.contains("active")).toBe(true);
  });

  it("renders one row per edge in the edges table", async () => {
    render(<FlowDiagram />);
    // Find the disclosure summary — it shows edge count.
    const summary = await screen.findByText(new RegExp(`Edges \\(${flow.length}\\)`));
    // Expand it so the table is in the DOM
    await act(async () => {
      (summary.parentElement as HTMLDetailsElement).open = true;
    });
    const table = document.querySelector(".flow-edges-table")!;
    const rows = table.querySelectorAll("tbody tr");
    expect(rows.length).toBe(flow.length);
  });

  it("renders specific known edges in the table (e.g. assign_dev)", async () => {
    render(<FlowDiagram />);
    const summary = await screen.findByText(/^Edges/);
    await act(async () => {
      (summary.parentElement as HTMLDetailsElement).open = true;
    });
    // assign_dev row should exist with 'spawn' effect
    const assign = screen.getByText("assign_dev").closest("tr")!;
    expect(assign.textContent).toContain("tech-lead");
    expect(assign.textContent).toContain("task-assignee");
    expect(assign.textContent).toContain("spawn");
  });

  it("calls mermaid.render with the state-machine source by default", async () => {
    const mermaid = (await import("mermaid")).default;
    render(<FlowDiagram />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
    const [, source] = (mermaid.render as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(source).toContain("stateDiagram-v2");
    expect(source).toContain("[*] --> new");
  });

  it("calls mermaid.render with the role-graph source after toggling", async () => {
    const mermaid = (await import("mermaid")).default;
    const user = userEvent.setup();
    render(<FlowDiagram />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalled());

    (mermaid.render as ReturnType<typeof vi.fn>).mockClear();
    await user.click(screen.getByRole("button", { name: "Role Graph" }));

    await waitFor(() => expect(mermaid.render).toHaveBeenCalled());
    const [, source] = (mermaid.render as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(source).toContain("flowchart LR");
  });
});
