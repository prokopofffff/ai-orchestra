import { useCallback } from "react";
import { usePolling } from "../hooks/usePolling";
import * as api from "../api";
import type { AuditEntry } from "../types";
import { ROLE_COLORS } from "../types";

interface Props {
  projectId: string;
}

export function SignalFeed({ projectId }: Props) {
  const fetcher = useCallback(() => api.fetchAudit(projectId, 100), [projectId]);
  const { data: entries } = usePolling(fetcher, 5000);

  if (!entries) return <div className="loading">Loading signals...</div>;

  return (
    <div className="signal-feed">
      <h2>Signal Feed</h2>
      <div className="signal-list">
        {entries.map((entry) => (
          <SignalEntry key={entry.id} entry={entry} />
        ))}
        {entries.length === 0 && <div className="empty">No signals yet</div>}
      </div>
    </div>
  );
}

function SignalEntry({ entry }: { entry: AuditEntry }) {
  const isRejected = entry.status === "rejected";

  return (
    <div className={`signal-entry ${isRejected ? "rejected" : "allowed"}`}>
      <div className="signal-header">
        <span className="signal-time">{new Date(entry.createdAt).toLocaleTimeString()}</span>
        <span className={`signal-status ${entry.status}`}>{entry.status}</span>
      </div>
      <div className="signal-route">
        <span className="signal-role" style={{ color: ROLE_COLORS[entry.fromRole] ?? "#666" }}>
          {entry.fromRole}
        </span>
        <span className="signal-arrow">{" → "}</span>
        <span className="signal-role" style={{ color: ROLE_COLORS[entry.toRole] ?? "#666" }}>
          {entry.toRole}
        </span>
        <span className="signal-action">{entry.action}</span>
      </div>
      {isRejected && entry.reason && (
        <div className="signal-reason">{entry.reason}</div>
      )}
    </div>
  );
}
