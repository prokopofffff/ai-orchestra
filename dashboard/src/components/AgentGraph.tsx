import { ROLE_COLORS, ROLE_FALLBACK } from "../types";

const roles = [
  { id: "tech-lead", label: "Tech Lead", x: 300, y: 50 },
  { id: "designer", label: "Designer", x: 100, y: 180 },
  { id: "frontend", label: "Frontend", x: 100, y: 310 },
  { id: "backend", label: "Backend", x: 500, y: 180 },
  { id: "qa", label: "QA", x: 300, y: 310 },
  { id: "devops", label: "DevOps", x: 500, y: 310 },
];

const connections = [
  ["tech-lead", "designer"],
  ["tech-lead", "frontend"],
  ["tech-lead", "backend"],
  ["tech-lead", "qa"],
  ["tech-lead", "devops"],
  ["designer", "tech-lead"],
  ["frontend", "tech-lead"],
  ["frontend", "qa"],
  ["backend", "tech-lead"],
  ["backend", "qa"],
  ["qa", "tech-lead"],
  ["devops", "tech-lead"],
];

export function AgentGraph() {
  const roleMap = Object.fromEntries(roles.map((r) => [r.id, r]));

  return (
    <div className="agent-graph">
      <h2>Agent Graph</h2>
      <svg viewBox="0 0 600 400" width="100%">
        {connections.map(([from, to], i) => {
          const f = roleMap[from];
          const t = roleMap[to];
          if (!f || !t) return null;
          return (
            <line
              key={i}
              x1={f.x} y1={f.y}
              x2={t.x} y2={t.y}
              stroke="var(--border)"
              strokeWidth={1}
              opacity={0.6}
            />
          );
        })}
        {roles.map((role) => (
          <g key={role.id}>
            <circle
              cx={role.x} cy={role.y} r={30}
              fill={ROLE_COLORS[role.id] ?? ROLE_FALLBACK}
              opacity={0.85}
            />
            <text
              x={role.x} y={role.y + 4}
              textAnchor="middle"
              fill="white"
              fontSize={11}
              fontWeight="bold"
            >
              {role.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
