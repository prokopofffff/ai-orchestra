import { useQuery } from "@tanstack/react-query";
import { ROLE_COLORS, ROLE_FALLBACK } from "../types";
import { fetchSessions, fetchAudit } from "../api";

interface GraphNode {
  role: string;
  label: string;
  x: number;
  y: number;
}

interface Edge {
  from: string;
  to: string;
  label: string;
  color: string;
}

const NODES: GraphNode[] = [
  { role: "tech-lead", label: "Tech Lead", x: 100, y: 40  },
  { role: "designer",  label: "Designer",  x: 500, y: 40  },
  { role: "backend",   label: "Backend",   x: 900, y: 40  },
  { role: "frontend",  label: "Frontend",  x: 100, y: 310 },
  { role: "qa",        label: "QA",        x: 500, y: 310 },
  { role: "devops",    label: "DevOps",    x: 900, y: 310 },
];

const EDGES: Edge[] = [
  { from: "tech-lead", to: "designer",  label: "create_design", color: "var(--color-accent-red)"    },
  { from: "designer",  to: "tech-lead", label: "design_ready",  color: "var(--color-accent-purple)" },
  { from: "tech-lead", to: "backend",   label: "assign_dev",    color: "var(--color-accent-blue)"   },
  { from: "tech-lead", to: "frontend",  label: "assign_dev",    color: "var(--color-accent-blue)"   },
  { from: "backend",   to: "qa",        label: "pr_created",    color: "var(--color-accent-green)"  },
  { from: "frontend",  to: "qa",        label: "pr_created",    color: "var(--color-accent-green)"  },
  { from: "qa",        to: "tech-lead", label: "tests_passed",  color: "var(--color-accent-yellow)" },
];

const NODE_W = 140;
const NODE_H = 120;
const CIRCLE = 100;
const CANVAS_W = 1120;
const CANVAS_H = 460;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

function nodeCenter(n: GraphNode): [number, number] {
  return [n.x + NODE_W / 2, n.y + CIRCLE / 2 + 10];
}

export function AgentGraph({ projectId }: { projectId: string }) {
  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => fetchSessions(projectId),
    refetchInterval: 5000,
  });

  const { data: audit = [] } = useQuery({
    queryKey: ["audit-graph", projectId],
    queryFn: () => fetchAudit(projectId, 30),
    refetchInterval: 5000,
  });

  const runningRoles = new Set(
    sessions.filter((s) => s.status === "running").map((s) => s.role),
  );

  // Most recent audit entry per from→to pair within the last 5 min
  const now = Date.now();
  const activeEdgeMap = new Map<string, string>(); // key: "from→to", value: signal action
  for (const entry of audit) {
    const key = `${entry.fromRole}→${entry.toRole}`;
    if (!activeEdgeMap.has(key) && now - new Date(entry.createdAt).getTime() < ACTIVE_WINDOW_MS) {
      activeEdgeMap.set(key, entry.action);
    }
  }

  const byRole = Object.fromEntries(NODES.map((n) => [n.role, n]));

  return (
    <section className="agent-graph flex flex-col gap-6">
      <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Agent Graph</h2>

      <div className="bg-bg-surface border border-border h-[480px] overflow-auto">
        <div className="relative" style={{ width: CANVAS_W, height: CANVAS_H }}>
          <svg
            className="absolute inset-0"
            width={CANVAS_W}
            height={CANVAS_H}
            viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          >
            {EDGES.map((e, i) => {
              const f = byRole[e.from];
              const t = byRole[e.to];
              if (!f || !t) return null;
              const [x1, y1] = nodeCenter(f);
              const [x2, y2] = nodeCenter(t);
              const mx = (x1 + x2) / 2;
              const my = (y1 + y2) / 2;
              const edgeKey = `${e.from}→${e.to}`;
              const isActive = activeEdgeMap.has(edgeKey);
              const signalLabel = isActive ? (activeEdgeMap.get(edgeKey) ?? e.label) : e.label;
              return (
                <g key={i} opacity={isActive ? 1 : 0.35}>
                  {isActive ? (
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={e.color} strokeWidth={3} strokeDasharray="10 5">
                      <animate attributeName="stroke-dashoffset" from="0" to="-15" dur="0.5s" repeatCount="indefinite" />
                    </line>
                  ) : (
                    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={e.color} strokeWidth={1} strokeDasharray="6 4" />
                  )}
                  <EdgeLabel x={mx} y={my} text={signalLabel} active={isActive} />
                </g>
              );
            })}
          </svg>

          {NODES.map((n) => (
            <GraphNodeView key={n.role} node={n} isRunning={runningRoles.has(n.role)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function GraphNodeView({ node, isRunning }: { node: GraphNode; isRunning: boolean }) {
  const color = ROLE_COLORS[node.role] ?? ROLE_FALLBACK;
  return (
    <div
      className="absolute"
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <div
        className="absolute grid place-items-center rounded-full font-semibold text-white"
        style={{
          left: (NODE_W - CIRCLE) / 2,
          top: 10,
          width: CIRCLE,
          height: CIRCLE,
          background: color,
          boxShadow: isRunning ? `0 0 28px 8px ${color}70` : `0 0 18px 2px ${color}40`,
          fontSize: 13,
          transition: "box-shadow 0.4s ease",
        }}
      >
        {node.label}
      </div>
      <span
        className={`absolute h-3 w-3 rounded-full border-2${isRunning ? " animate-pulse" : ""}`}
        style={{
          top: 8,
          right: 18,
          background: isRunning ? "var(--color-accent-green)" : "var(--color-text-tertiary)",
          borderColor: "var(--color-bg-surface)",
        }}
      />
      <span
        className="absolute left-0 right-0 text-center font-mono text-[10px] uppercase tracking-wider"
        style={{
          top: NODE_H - 6,
          color: isRunning ? "var(--color-accent-green)" : "var(--color-text-tertiary)",
        }}
      >
        {isRunning ? "running" : "idle"}
      </span>
    </div>
  );
}

function EdgeLabel({ x, y, text, active }: { x: number; y: number; text: string; active?: boolean }) {
  const padding = 8;
  const width = text.length * 6.2 + padding * 2;
  const height = 18;
  return (
    <g>
      <rect
        x={x - width / 2}
        y={y - height / 2}
        width={width}
        height={height}
        fill={active ? "#1a2535" : "#1e1e25"}
        rx={2}
      />
      <text
        x={x}
        y={y + 3}
        textAnchor="middle"
        fontSize="10"
        fontFamily="'IBM Plex Mono', ui-monospace, monospace"
        fill={active ? "var(--color-accent-blue)" : "var(--color-text-secondary)"}
        fontWeight={active ? "600" : "400"}
      >
        {text}
      </text>
    </g>
  );
}
