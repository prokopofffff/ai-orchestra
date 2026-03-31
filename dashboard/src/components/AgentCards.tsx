import type { AgentSession } from "../types";

interface Props {
  sessions: AgentSession[];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusBadge(status: string): { text: string; className: string } {
  switch (status) {
    case "running":
      return { text: "running", className: "badge badge-running" };
    case "sleeping":
      return { text: "sleeping", className: "badge badge-sleeping" };
    case "terminated":
      return { text: "terminated", className: "badge badge-terminated" };
    default:
      return { text: status, className: "badge" };
  }
}

export function AgentCards({ sessions }: Props) {
  const active = sessions.filter((s) => s.status !== "terminated");

  if (active.length === 0) {
    return (
      <div className="section">
        <h2>Active Agents</h2>
        <p className="empty">No active agents</p>
      </div>
    );
  }

  return (
    <div className="section">
      <h2>Active Agents ({active.length})</h2>
      <div className="card-grid">
        {active.map((s) => {
          const badge = statusBadge(s.status);
          return (
            <div key={s.id} className="card">
              <div className="card-header">
                <strong>{s.role}</strong>
                <span className={badge.className}>{badge.text}</span>
              </div>
              <div className="card-body">
                {s.taskId && <div>Task: #{s.taskId}</div>}
                <div>Project: {s.projectId}</div>
                <div className="card-time">{timeAgo(s.lastActiveAt)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
