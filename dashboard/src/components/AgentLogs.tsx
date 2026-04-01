import { useState, useCallback, useRef, useEffect } from "react";
import { usePolling } from "../hooks/usePolling";
import { ROLE_COLORS } from "../types";

interface LogEntry {
  id: string;
  projectId: string;
  sessionId: string | null;
  role: string;
  level: "stdout" | "stderr" | "system" | "error";
  message: string;
  createdAt: string;
}

interface Props {
  projectId: string;
}

const LEVEL_COLORS: Record<string, string> = {
  stdout: "#e6edf3",
  stderr: "#f85149",
  system: "#8b949e",
  error: "#f85149",
};

export function AgentLogs({ projectId }: Props) {
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [levelFilter, setLevelFilter] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetcher = useCallback(async () => {
    const params = new URLSearchParams({ projectId, limit: "300" });
    if (roleFilter) params.set("role", roleFilter);
    if (levelFilter) params.set("level", levelFilter);
    const res = await fetch(`/api/logs?${params}`);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json() as Promise<LogEntry[]>;
  }, [projectId, roleFilter, levelFilter]);

  const { data: logs } = usePolling(fetcher, 3000);

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs?.length, autoScroll]);

  const roles = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"];
  const levels = ["stdout", "stderr", "system", "error"];

  // Reverse to show chronological (API returns DESC)
  const displayLogs = logs ? [...logs].reverse() : [];

  return (
    <div className="agent-logs">
      <div className="logs-header">
        <h2>Agent Logs</h2>
        <div className="logs-filters">
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">All roles</option>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
            <option value="">All levels</option>
            {levels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <label className="auto-scroll">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
        </div>
      </div>
      <div className="logs-container">
        {displayLogs.map((log) => (
          <div key={log.id} className={`log-entry level-${log.level}`}>
            <span className="log-time">{new Date(log.createdAt).toLocaleTimeString()}</span>
            <span className="log-role" style={{ color: ROLE_COLORS[log.role] ?? "#8b949e" }}>{log.role}</span>
            <span className="log-level" style={{ color: LEVEL_COLORS[log.level] }}>[{log.level}]</span>
            <span className="log-message">{log.message}</span>
          </div>
        ))}
        {displayLogs.length === 0 && <div className="empty">No logs yet</div>}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
