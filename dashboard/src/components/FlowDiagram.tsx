import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import {
  renderStateMachineMermaid,
  renderRoleGraphMermaid,
  flowAsJson,
} from "@ai-orchestra/shared";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  securityLevel: "loose",
  flowchart: { curve: "basis" },
});

type View = "state" | "roles";

export function FlowDiagram() {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("state");
  const [error, setError] = useState<string | null>(null);

  // Source of truth lives in @ai-orchestra/shared — same package the backend's
  // flow-guard + dispatcher use. No API call needed; what's rendered here is
  // exactly what the backend executes.
  const src = view === "state" ? renderStateMachineMermaid() : renderRoleGraphMermaid();

  useEffect(() => {
    if (!src || !ref.current) return;
    let cancelled = false;
    const id = `mermaid-${view}-${Date.now()}`;
    setError(null);
    mermaid
      .render(id, src)
      .then(({ svg }) => {
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [src, view]);

  const json = flowAsJson();

  return (
    <div className="flow-diagram">
      <div className="flow-header">
        <h2>Flow</h2>
        <div className="flow-view-toggle">
          <button
            className={view === "state" ? "active" : ""}
            onClick={() => setView("state")}
          >
            State Machine
          </button>
          <button
            className={view === "roles" ? "active" : ""}
            onClick={() => setView("roles")}
          >
            Role Graph
          </button>
        </div>
      </div>
      {error && <div className="flow-error">Failed to render: {error}</div>}
      <div className="flow-canvas" ref={ref} />
      <details className="flow-source">
        <summary>Edges ({json.edges.length})</summary>
        <table className="flow-edges-table">
          <thead>
            <tr><th>action</th><th>from</th><th>→ to</th><th>state</th><th>effect</th><th>description</th></tr>
          </thead>
          <tbody>
            {json.edges.map((e) => (
              <tr key={e.action}>
                <td><code>{e.action}</code></td>
                <td>{e.from.join(", ")}</td>
                <td>{e.to}</td>
                <td>{e.fromStates ? `${e.fromStates.join("|")} → ${e.toState}` : ""}</td>
                <td>{e.effect}</td>
                <td>{e.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details className="flow-source">
        <summary>Mermaid source</summary>
        <pre>{src}</pre>
      </details>
    </div>
  );
}
