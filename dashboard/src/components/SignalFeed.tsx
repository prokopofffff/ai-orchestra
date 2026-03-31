import type { AuditEntry } from "../types";

interface Props {
  entries: AuditEntry[];
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString();
}

export function SignalFeed({ entries }: Props) {
  return (
    <div className="signal-feed">
      <h2>Signal Feed</h2>
      <div className="feed-list">
        {entries.length === 0 && <p className="empty">No signals yet</p>}
        {entries.map((e) => (
          <div
            key={e.id}
            className={`feed-entry ${e.allowed ? "" : "feed-rejected"}`}
          >
            <span className="feed-time">{formatTime(e.timestamp)}</span>
            <span className="feed-route">
              {e.from_agent} → {e.to_agent}
            </span>
            <span className="feed-action">{e.action}</span>
            {!e.allowed && (
              <span className="feed-reason" title={e.reason || ""}>
                REJECTED
              </span>
            )}
            {e.task_id && <span className="feed-task">#{e.task_id}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
