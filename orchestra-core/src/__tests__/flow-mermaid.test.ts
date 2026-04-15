import { describe, it, expect } from "vitest";
import {
  renderStateMachineMermaid,
  renderRoleGraphMermaid,
  flowAsJson,
  flow,
  getAllStates,
} from "@ai-orchestra/shared";

describe("flow-mermaid — renderStateMachineMermaid", () => {
  it("starts with stateDiagram-v2 and entry edge", () => {
    const src = renderStateMachineMermaid();
    expect(src.startsWith("stateDiagram-v2")).toBe(true);
    expect(src).toContain("[*] --> new");
  });

  it("includes every action edge that declares a transition", () => {
    const src = renderStateMachineMermaid();
    for (const edge of flow) {
      if (!edge.transition) continue;
      for (const fromState of edge.transition.from) {
        if (fromState === edge.transition.to) continue;
        // Label format: "action (from-role|from-role)"
        const label = `${edge.action} (${edge.allowedFrom.join("|")})`;
        expect(src).toContain(`${fromState} --> ${edge.transition.to}: ${label}`);
      }
    }
  });

  it("terminates at closed → [*]", () => {
    const src = renderStateMachineMermaid();
    expect(src).toContain("merged --> closed");
    expect(src).toContain("closed --> [*]");
  });
});

describe("flow-mermaid — renderRoleGraphMermaid", () => {
  it("emits a flowchart with every (sender, action, target) triple", () => {
    const src = renderRoleGraphMermaid();
    expect(src.startsWith("flowchart LR")).toBe(true);

    // Pick one well-known edge: tech-lead --|create_design|--> designer
    expect(src).toContain("tech_lead -->|create_design| designer");
    // QA failures go to tech-lead
    expect(src).toContain("qa -->|tests_failed| tech_lead");
    // System task_unblocked goes to task-assignee
    expect(src).toContain("system -->|task_unblocked| task_assignee");
  });
});

describe("flow-mermaid — flowAsJson", () => {
  it("exports every state from getAllStates and every edge from flow", () => {
    const json = flowAsJson();
    expect(json.states).toEqual(getAllStates());
    expect(json.edges).toHaveLength(flow.length);
  });

  it("each edge carries the shape the dashboard renders", () => {
    const json = flowAsJson();
    const assignDev = json.edges.find((e) => e.action === "assign_dev");
    expect(assignDev).toMatchObject({
      action: "assign_dev",
      from: ["tech-lead"],
      to: "task-assignee",
      fromStates: ["described", "design_ready", "failed", "revisions"],
      toState: "in_development",
      effect: "spawn",
    });
    expect(typeof assignDev?.description).toBe("string");
    expect(assignDev?.description.length).toBeGreaterThan(0);
  });

  it("edges with no transition omit fromStates/toState", () => {
    const json = flowAsJson();
    const notify = json.edges.find((e) => e.action === "notify");
    expect(notify?.fromStates).toBeUndefined();
    expect(notify?.toState).toBeUndefined();
    expect(notify?.effect).toBe("notify-user");
    expect(notify?.to).toBe("user");
  });
});
