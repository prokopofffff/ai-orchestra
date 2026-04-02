import { useCallback } from "react";
import { usePolling } from "../hooks/usePolling";
import * as api from "../api";
import { ROLE_COLORS } from "../types";

interface Props {
  projectId: string;
}

export function AgentCards({ projectId }: Props) {
  const fetcher = useCallback(() => api.fetchSessions(projectId), [projectId]);
  const { data: sessions } = usePolling(fetcher, 5000);

  if (!sessions?.length) return <div className="agent-cards empty">No active agents</div>;

  return (
    <div className="agent-cards">
      <h2>Active Agents</h2>
      <div className="cards-grid">
        {sessions.map((s) => (
          <div key={s.id} className={`agent-card status-${s.status}`}>
            <div className="card-role" style={{ borderLeftColor: ROLE_COLORS[s.role] ?? "#999" }}>
              {s.role}
            </div>
            <div className="card-details">
              <span className="card-model">{s.model}</span>
              <span className="card-status">{s.status}</span>
              {s.pid && <span className="card-pid">pid:{s.pid}</span>}
            </div>
            {s.worktreePath && (
              <div className="card-workdir" title={s.worktreePath}>
                {s.worktreePath.replace(/.*orchestra-workspaces\//, "~/")}
              </div>
            )}
            {s.startedAt && (
              <div className="card-started">
                Started: {new Date(s.startedAt).toLocaleTimeString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
