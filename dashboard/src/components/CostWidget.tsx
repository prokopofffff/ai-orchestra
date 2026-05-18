import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { ROLE_COLORS, ROLE_FALLBACK } from "../types";
import { useProjectContext } from "../contexts/ProjectContext";

/**
 * 24h spend on the current project + configured cap, with role/model breakdown.
 * Renders nothing for users without a project; otherwise refreshes every 15s.
 */
export function CostWidget() {
  const { project } = useProjectContext();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["usage-today", project?.id],
    queryFn: () => api.fetchUsageToday(project!.id),
    enabled: !!project,
    refetchInterval: 15_000,
  });

  if (!project || isLoading || isError || !data) return null;

  const total = data.total;
  const cap = data.cap;
  const ratio = cap > 0 ? Math.min(1, total / cap) : 0;
  const overCap = cap > 0 && total >= cap;

  return (
    <section className="cost-widget flex flex-col gap-3 bg-bg-surface border border-border p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">Стоимость · 24ч</h3>
        <span className="font-mono text-[11px] text-text-tertiary">
          {cap > 0 ? `лимит $${cap.toFixed(2)}` : "без лимита"}
        </span>
      </header>

      <div className="flex items-baseline gap-2">
        <span className={`text-2xl font-semibold ${overCap ? "text-accent-red" : "text-text-primary"}`}>
          ${total.toFixed(2)}
        </span>
        {cap > 0 && (
          <span className="text-xs text-text-tertiary">/ ${cap.toFixed(2)}</span>
        )}
      </div>

      {cap > 0 && (
        <div className="cost-bar-track h-1.5 bg-bg-input overflow-hidden">
          <div
            className="cost-bar-fill h-full transition-all"
            style={{
              width: `${ratio * 100}%`,
              background: overCap ? "var(--color-accent-red, #e74c3c)" : "var(--color-accent-blue, #3b82f6)",
            }}
          />
        </div>
      )}

      {Object.keys(data.byRole).length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">По ролям</h4>
          {Object.entries(data.byRole)
            .sort((a, b) => b[1] - a[1])
            .map(([role, cost]) => {
              const color = ROLE_COLORS[role] ?? ROLE_FALLBACK;
              return (
                <div key={role} className="flex items-center justify-between text-xs">
                  <span style={{ color }} className="font-medium">{role}</span>
                  <span className="font-mono text-text-tertiary">${cost.toFixed(2)}</span>
                </div>
              );
            })}
        </div>
      )}

      {Object.keys(data.byModel).length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">По моделям</h4>
          {Object.entries(data.byModel)
            .sort((a, b) => b[1] - a[1])
            .map(([model, cost]) => (
              <div key={model} className="flex items-center justify-between text-xs">
                <span className="text-text-primary">{model}</span>
                <span className="font-mono text-text-tertiary">${cost.toFixed(2)}</span>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
