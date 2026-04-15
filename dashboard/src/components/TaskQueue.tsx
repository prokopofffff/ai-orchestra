import { useQuery } from "@tanstack/react-query";
import * as api from "../api";

export function TaskQueue() {
  const { data: status } = useQuery({
    queryKey: ["queue-status"],
    queryFn: api.fetchQueueStatus,
    refetchInterval: 5_000,
  });

  if (!status) return null;

  return (
    <div className="task-queue">
      <h2>Queue Status</h2>
      <div className="queue-stats">
        <div className="stat">
          <span className="stat-value">{status.queued}</span>
          <span className="stat-label">Queued</span>
        </div>
        <div className="stat">
          <span className="stat-value">{status.running}</span>
          <span className="stat-label">Running</span>
        </div>
        <div className="stat">
          <span className="stat-value">{status.completed}</span>
          <span className="stat-label">Completed</span>
        </div>
        <div className="stat">
          <span className="stat-value">{status.failed}</span>
          <span className="stat-label">Failed</span>
        </div>
      </div>
      {status.rateLimited && (
        <div className="queue-rate-limited">
          Rate limited until {status.rateLimitResetTime
            ? new Date(status.rateLimitResetTime).toLocaleTimeString()
            : "unknown"}
        </div>
      )}
    </div>
  );
}
