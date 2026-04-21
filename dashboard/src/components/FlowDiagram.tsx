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
    <div className="flow-diagram flex flex-col gap-8 px-16 py-12 h-full min-h-0">
      <header className="flow-header flex items-end justify-between gap-8">
        <h2 className="text-5xl font-semibold tracking-tight text-text-primary" style={{ letterSpacing: "-2px" }}>
          Flow
        </h2>
        <div className="flow-view-toggle flex h-9 border border-border">
          <ToggleButton active={view === "state"} onClick={() => setView("state")}>
            State Machine
          </ToggleButton>
          <ToggleButton active={view === "roles"} onClick={() => setView("roles")}>
            Role Graph
          </ToggleButton>
        </div>
      </header>

      {error && (
        <div className="flow-error text-sm text-accent-red bg-accent-red/10 px-3 py-2">
          Failed to render: {error}
        </div>
      )}

      <div
        className="flow-canvas flex-1 min-h-[400px] bg-bg-surface border border-border p-4 overflow-auto grid place-items-center"
        ref={ref}
      />

      <details className="flow-source">
        <summary className="cursor-pointer text-xs text-text-tertiary hover:text-text-secondary font-mono py-1">
          Edges ({json.edges.length})
        </summary>
        <div className="overflow-x-auto">
          <table className="flow-edges-table w-full mt-2 text-xs border-collapse">
            <thead>
              <tr className="text-text-tertiary font-mono text-[11px] uppercase tracking-wider">
                <th className="text-left py-1.5 px-2 border-b border-border">action</th>
                <th className="text-left py-1.5 px-2 border-b border-border">from</th>
                <th className="text-left py-1.5 px-2 border-b border-border">→ to</th>
                <th className="text-left py-1.5 px-2 border-b border-border">state</th>
                <th className="text-left py-1.5 px-2 border-b border-border">effect</th>
                <th className="text-left py-1.5 px-2 border-b border-border">description</th>
              </tr>
            </thead>
            <tbody>
              {json.edges.map((e) => (
                <tr key={e.action} className="align-top">
                  <td className="py-1.5 px-2 border-b border-border-subtle">
                    <code className="font-mono text-[11px] text-accent-blue bg-bg-input px-1.5 py-0.5">{e.action}</code>
                  </td>
                  <td className="py-1.5 px-2 border-b border-border-subtle text-text-secondary">
                    {e.from.join(", ")}
                  </td>
                  <td className="py-1.5 px-2 border-b border-border-subtle text-text-secondary">{e.to}</td>
                  <td className="py-1.5 px-2 border-b border-border-subtle font-mono text-[11px] text-text-tertiary">
                    {e.fromStates ? `${e.fromStates.join("|")} → ${e.toState}` : ""}
                  </td>
                  <td className="py-1.5 px-2 border-b border-border-subtle text-text-secondary">{e.effect}</td>
                  <td className="py-1.5 px-2 border-b border-border-subtle text-text-secondary">{e.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details className="flow-source">
        <summary className="cursor-pointer text-xs text-text-tertiary hover:text-text-secondary font-mono py-1">
          Mermaid source
        </summary>
        <pre className="mt-2 bg-bg-sidebar border border-border-subtle p-3 text-[11px] text-text-tertiary font-mono overflow-x-auto">
          {src}
        </pre>
      </details>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        active ? "active" : "",
        "h-full px-4 text-xs font-medium transition-colors",
        active
          ? "bg-accent-blue text-white"
          : "bg-transparent text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
