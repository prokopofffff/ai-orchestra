import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { ROLE_COLORS, ROLE_FALLBACK } from "../types";

interface Props {
  projectId: string;
}

const STATUS_COLOR: Record<string, string> = {
  running:  "var(--color-accent-green)",
  sleeping: "var(--color-accent-yellow)",
  crashed:  "var(--color-accent-red)",
};

export function AgentCards({ projectId }: Props) {
  const { data: sessions } = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.fetchSessions(projectId),
    refetchInterval: 5_000,
  });

  if (!sessions?.length) {
    return (
      <div className="agent-cards empty text-sm text-text-tertiary italic">
        No active agents
      </div>
    );
  }

  return (
    <section className="agent-cards flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-text-primary">Active Agents</h3>
      <div className="cards-grid flex gap-3 flex-wrap">
        {sessions.map((s) => {
          const roleColor = ROLE_COLORS[s.role] ?? ROLE_FALLBACK;
          const statusColor = STATUS_COLOR[s.status] ?? ROLE_FALLBACK;
          return (
            <article
              key={s.id}
              className={[
                "agent-card",
                `status-${s.status}`,
                "flex flex-col gap-1.5 bg-bg-surface border border-border px-4 py-2.5",
              ].join(" ")}
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ background: statusColor }}
                />
                <span
                  className="card-role text-[13px] font-medium"
                  style={{ color: roleColor }}
                >
                  {s.role}
                </span>
                <span className="card-status ml-auto font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
                  {s.status}
                </span>
              </div>
              <div className="card-details flex items-center gap-3 text-[11px] text-text-tertiary font-mono">
                <span className="card-model">{s.model}</span>
                {s.startedAt && (
                  <span className="card-started">
                    · {new Date(s.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </div>
              {s.worktreePath && (
                <div
                  className="card-workdir text-[10px] font-mono text-accent-blue truncate"
                  title={s.worktreePath}
                >
                  {s.worktreePath.replace(/.*orchestra-workspaces\//, "~/")}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
