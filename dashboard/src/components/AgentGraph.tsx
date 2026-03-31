import type { AgentSession, AuditEntry } from "../types";

interface Props {
  sessions: AgentSession[];
  recentSignals: AuditEntry[];
}

const NODES: Record<string, { x: number; y: number; label: string; color: string }> = {
  "tech-lead": { x: 250, y: 40, label: "Tech Lead", color: "#6366f1" },
  designer:    { x: 80,  y: 140, label: "Designer",  color: "#ec4899" },
  frontend:    { x: 250, y: 140, label: "Frontend",  color: "#3b82f6" },
  backend:     { x: 420, y: 140, label: "Backend",   color: "#10b981" },
  qa:          { x: 165, y: 240, label: "QA",        color: "#f59e0b" },
  devops:      { x: 335, y: 240, label: "DevOps",    color: "#8b5cf6" },
};

const EDGES: [string, string][] = [
  ["tech-lead", "designer"],
  ["tech-lead", "frontend"],
  ["tech-lead", "backend"],
  ["tech-lead", "devops"],
  ["designer", "tech-lead"],
  ["frontend", "tech-lead"],
  ["frontend", "qa"],
  ["backend", "tech-lead"],
  ["backend", "qa"],
  ["qa", "tech-lead"],
  ["devops", "tech-lead"],
];

function getStatus(role: string, sessions: AgentSession[]): "running" | "sleeping" | "none" {
  const session = sessions.find((s) => s.role === role && s.status !== "terminated");
  if (!session) return "none";
  return session.status as "running" | "sleeping";
}

function statusColor(status: "running" | "sleeping" | "none"): string {
  if (status === "running") return "#22c55e";
  if (status === "sleeping") return "#facc15";
  return "#6b7280";
}

function isRecentEdge(from: string, to: string, signals: AuditEntry[]): boolean {
  return signals.some(
    (s) => s.from_agent === from && s.to_agent === to && s.allowed
  );
}

export function AgentGraph({ sessions, recentSignals }: Props) {
  const recent = recentSignals.slice(0, 20);

  return (
    <svg viewBox="0 0 500 300" style={{ width: "100%", height: "100%" }}>
      {/* Edges */}
      {EDGES.map(([from, to]) => {
        const a = NODES[from];
        const b = NODES[to];
        if (!a || !b) return null;
        const active = isRecentEdge(from, to, recent);
        return (
          <line
            key={`${from}-${to}`}
            x1={a.x} y1={a.y + 18}
            x2={b.x} y2={b.y + 18}
            stroke={active ? "#6366f1" : "#374151"}
            strokeWidth={active ? 2.5 : 1}
            strokeDasharray={active ? "none" : "4 4"}
            opacity={active ? 1 : 0.4}
          />
        );
      })}

      {/* Nodes */}
      {Object.entries(NODES).map(([role, { x, y, label, color }]) => {
        const status = getStatus(role, sessions);
        return (
          <g key={role}>
            <rect
              x={x - 45} y={y}
              width={90} height={36}
              rx={8}
              fill={color}
              opacity={status === "none" ? 0.3 : 0.9}
            />
            <circle
              cx={x + 38} cy={y + 7}
              r={5}
              fill={statusColor(status)}
            />
            <text
              x={x} y={y + 23}
              textAnchor="middle"
              fill="white"
              fontSize={12}
              fontWeight={600}
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
