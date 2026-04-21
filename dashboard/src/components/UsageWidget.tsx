import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { ROLE_COLORS, ROLE_FALLBACK } from "../types";

export function UsageWidget() {
  const { data: usage } = useQuery({
    queryKey: ["usage"],
    queryFn: api.fetchUsage,
    refetchInterval: 10_000,
  });

  if (!usage) return null;

  const { sessions, byRole, byModel } = usage;
  const roleTotal = Math.max(sessions.total, 1);

  return (
    <section className="usage-widget flex flex-col gap-4 bg-bg-surface border border-border p-4">
      <h3 className="text-sm font-semibold text-text-primary">Usage</h3>

      <div className="usage-sessions grid grid-cols-4 gap-2">
        <MiniStat label="Total"     value={sessions.total} />
        <MiniStat label="Running"   value={sessions.running}   accent="text-accent-green" className="running" />
        <MiniStat label="Completed" value={sessions.completed} />
        {sessions.crashed > 0
          ? <MiniStat label="Crashed" value={sessions.crashed} accent="text-accent-red" className="crashed" />
          : <div />}
      </div>

      {Object.keys(byRole).length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">By Role</h4>
          <div className="usage-bars flex flex-col gap-2">
            {Object.entries(byRole)
              .sort((a, b) => b[1].sessions - a[1].sessions)
              .map(([role, data]) => {
                const color = ROLE_COLORS[role] ?? ROLE_FALLBACK;
                const width = Math.max(8, (data.sessions / roleTotal) * 100);
                return (
                  <div key={role} className="usage-bar-row flex items-center gap-3">
                    <span className="usage-bar-label text-xs font-medium w-[76px] truncate" style={{ color }}>
                      {role}
                    </span>
                    <div className="usage-bar-track flex-1 h-1.5 bg-bg-input overflow-hidden">
                      <div
                        className="usage-bar-fill h-full transition-all"
                        style={{ width: `${width}%`, background: color }}
                      />
                    </div>
                    <span className="usage-bar-count text-[11px] font-mono text-text-tertiary min-w-[80px] text-right">
                      {data.sessions}{data.running > 0 ? ` (${data.running} active)` : ""}
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {Object.keys(byModel).length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">By Model</h4>
          <div className="usage-model-list flex flex-col">
            {Object.entries(byModel)
              .sort((a, b) => b[1] - a[1])
              .map(([model, count]) => (
                <div key={model} className="usage-model-row flex items-center justify-between text-xs py-1">
                  <span className="usage-model-name text-text-primary">{model}</span>
                  <span className="usage-model-count font-mono text-text-tertiary">{count} sessions</span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="usage-updated font-mono text-[10px] text-text-tertiary text-right">
        Updated: {new Date(usage.lastChecked).toLocaleTimeString()}
      </div>
    </section>
  );
}

function MiniStat({
  label,
  value,
  accent,
  className = "",
}: { label: string; value: number; accent?: string; className?: string }) {
  return (
    <div className={`usage-stat ${className} flex flex-col items-center bg-bg-input px-3 py-2`}>
      <span className={["usage-value text-lg font-semibold text-text-primary", accent].filter(Boolean).join(" ")}>
        {value}
      </span>
      <span className="usage-label font-mono text-[9px] uppercase tracking-wider text-text-tertiary">
        {label}
      </span>
    </div>
  );
}
