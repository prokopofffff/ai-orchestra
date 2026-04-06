import { useCallback } from "react";
import { usePolling } from "../hooks/usePolling";
import * as api from "../api";
import { ROLE_COLORS } from "../types";

export function UsageWidget() {
  const fetcher = useCallback(() => api.fetchUsage(), []);
  const { data: usage } = usePolling(fetcher, 10000);

  if (!usage) return null;

  const { sessions, byRole, byModel } = usage;

  return (
    <div className="usage-widget">
      <h2>Usage</h2>

      <div className="usage-sessions">
        <div className="usage-stat">
          <span className="usage-value">{sessions.total}</span>
          <span className="usage-label">Total Sessions</span>
        </div>
        <div className="usage-stat running">
          <span className="usage-value">{sessions.running}</span>
          <span className="usage-label">Running</span>
        </div>
        <div className="usage-stat">
          <span className="usage-value">{sessions.completed}</span>
          <span className="usage-label">Completed</span>
        </div>
        {sessions.crashed > 0 && (
          <div className="usage-stat crashed">
            <span className="usage-value">{sessions.crashed}</span>
            <span className="usage-label">Crashed</span>
          </div>
        )}
      </div>

      {Object.keys(byRole).length > 0 && (
        <div className="usage-section">
          <h3>By Role</h3>
          <div className="usage-bars">
            {Object.entries(byRole)
              .sort((a, b) => b[1].sessions - a[1].sessions)
              .map(([role, data]) => (
                <div key={role} className="usage-bar-row">
                  <span className="usage-bar-label" style={{ color: ROLE_COLORS[role] ?? "#8b949e" }}>
                    {role}
                  </span>
                  <div className="usage-bar-track">
                    <div
                      className="usage-bar-fill"
                      style={{
                        width: `${Math.max(8, (data.sessions / sessions.total) * 100)}%`,
                        backgroundColor: ROLE_COLORS[role] ?? "#8b949e",
                      }}
                    />
                  </div>
                  <span className="usage-bar-count">
                    {data.sessions}{data.running > 0 ? ` (${data.running} active)` : ""}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {Object.keys(byModel).length > 0 && (
        <div className="usage-section">
          <h3>By Model</h3>
          <div className="usage-model-list">
            {Object.entries(byModel)
              .sort((a, b) => b[1] - a[1])
              .map(([model, count]) => (
                <div key={model} className="usage-model-row">
                  <span className="usage-model-name">{model}</span>
                  <span className="usage-model-count">{count} sessions</span>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="usage-updated">
        Updated: {new Date(usage.lastChecked).toLocaleTimeString()}
      </div>
    </div>
  );
}
