import { flow, getAllStates, type Edge } from "./flow";

/**
 * Render the task state machine as a Mermaid stateDiagram-v2.
 *
 * Each state is a node; each action edge that has a transition becomes an
 * arrow labeled with `action (from-role)`. Idempotent same-state edges
 * (e.g. pr_created → pr_created on re-submit) are skipped to keep it readable.
 */
export function renderStateMachineMermaid(): string {
  const lines: string[] = ["stateDiagram-v2", "  [*] --> new"];

  for (const e of flow) {
    if (!e.transition) continue;
    const label = `${e.action} (${e.allowedFrom.join("|")})`;
    for (const fromState of e.transition.from) {
      if (fromState === e.transition.to) continue;
      lines.push(`  ${fromState} --> ${e.transition.to}: ${label}`);
    }
  }

  // Implicit terminal flows
  lines.push("  merged --> closed");
  lines.push("  closed --> [*]");

  return lines.join("\n");
}

/**
 * Render the role-to-role communication graph as a Mermaid flowchart.
 * Nodes are roles; edges are actions that flow between them.
 */
export function renderRoleGraphMermaid(): string {
  const lines: string[] = ["flowchart LR"];
  const seen = new Set<string>();

  for (const e of flow) {
    const targetLabel = targetToLabel(e);
    for (const from of e.allowedFrom) {
      const key = `${from}->${targetLabel}:${e.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${nodeId(from)} -->|${e.action}| ${nodeId(targetLabel)}`);
    }
  }

  return lines.join("\n");
}

function targetToLabel(e: Edge): string {
  switch (e.target.kind) {
    case "role": return e.target.role;
    case "user": return "user";
    case "task-assignee": return "task-assignee";
    case "addressed-role": return "addressed-role";
  }
}

function nodeId(s: string): string {
  return s.replace(/-/g, "_");
}

/**
 * JSON projection of the flow — useful for dashboard rendering or external tools
 * that don't speak Mermaid.
 */
export function flowAsJson(): {
  states: string[];
  edges: Array<{
    action: string;
    from: string[];
    to: string;
    fromStates?: string[];
    toState?: string;
    effect: string;
    description: string;
  }>;
} {
  return {
    states: getAllStates(),
    edges: flow.map((e) => ({
      action: e.action,
      from: e.allowedFrom,
      to: targetToLabel(e),
      fromStates: e.transition?.from,
      toState: e.transition?.to,
      effect: e.effect.kind,
      description: e.description,
    })),
  };
}
