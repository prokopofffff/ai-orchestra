import { ROLE_COLORS, ROLE_FALLBACK } from "../types";

type NodeStatus = "running" | "idle";

interface GraphNode {
  role: string;
  label: string;
  x: number;   // top-left of 140×120 box, in .pen coords
  y: number;
  status: NodeStatus;
}

const NODES: GraphNode[] = [
  { role: "tech-lead", label: "Tech Lead", x: 100, y: 40,  status: "running" },
  { role: "designer",  label: "Designer",  x: 500, y: 40,  status: "idle"    },
  { role: "backend",   label: "Backend",   x: 900, y: 40,  status: "running" },
  { role: "frontend",  label: "Frontend",  x: 100, y: 310, status: "idle"    },
  { role: "qa",        label: "QA",        x: 500, y: 310, status: "idle"    },
  { role: "devops",    label: "DevOps",    x: 900, y: 310, status: "idle"    },
];

interface Edge {
  from: string;
  to: string;
  label: string;
  color: string;    // CSS var reference
  active?: boolean; // pen highlights TL → Backend as the live edge
}

const EDGES: Edge[] = [
  { from: "tech-lead", to: "designer", label: "create_design", color: "var(--color-accent-red)" },
  { from: "designer",  to: "tech-lead", label: "design_ready",  color: "var(--color-accent-purple)" },
  { from: "tech-lead", to: "backend",  label: "assign_dev",    color: "var(--color-accent-blue)", active: true },
  { from: "tech-lead", to: "frontend", label: "assign_dev",    color: "var(--color-accent-blue)" },
  { from: "backend",   to: "qa",       label: "pr_created",    color: "var(--color-accent-green)" },
  { from: "frontend",  to: "qa",       label: "pr_created",    color: "var(--color-accent-green)" },
  { from: "qa",        to: "tech-lead", label: "tests_passed", color: "var(--color-accent-yellow)" },
];

const NODE_W = 140;
const NODE_H = 120;
const CIRCLE = 100;
const CANVAS_W = 1120;
const CANVAS_H = 460;

function nodeCenter(n: GraphNode): [number, number] {
  return [n.x + NODE_W / 2, n.y + CIRCLE / 2 + 10];
}

export function AgentGraph() {
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
              return (
                <g key={i} opacity={e.active ? 1 : 0.5}>
                  <line
                    x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={e.color}
                    strokeWidth={e.active ? 3 : 1}
                    strokeDasharray={e.active ? undefined : "6 4"}
                  />
                  <EdgeLabel x={mx} y={my} text={e.label} />
                </g>
              );
            })}
          </svg>

          {NODES.map((n) => (
            <GraphNodeView key={n.role} node={n} />
          ))}
        </div>
      </div>
    </section>
  );
}

function GraphNodeView({ node }: { node: GraphNode }) {
  const color = ROLE_COLORS[node.role] ?? ROLE_FALLBACK;
  const statusColor = node.status === "running" ? "var(--color-accent-green)" : "var(--color-text-tertiary)";
  return (
    <div
      className="absolute"
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <div
        className="absolute grid place-items-center rounded-full text-white font-semibold"
        style={{
          left: (NODE_W - CIRCLE) / 2,
          top: 10,
          width: CIRCLE,
          height: CIRCLE,
          background: color,
          boxShadow: `0 0 18px 2px ${color}40`,
          fontSize: 13,
        }}
      >
        {node.label}
      </div>
      <span
        className="absolute h-3 w-3 rounded-full border-2"
        style={{
          top: 8,
          right: 18,
          background: statusColor,
          borderColor: "var(--color-bg-surface)",
        }}
      />
      <span
        className="absolute left-0 right-0 text-center font-mono text-[10px] uppercase tracking-wider"
        style={{
          top: NODE_H - 6,
          color: node.status === "running" ? "var(--color-accent-green)" : "var(--color-text-tertiary)",
        }}
      >
        {node.status}
      </span>
    </div>
  );
}

function EdgeLabel({ x, y, text }: { x: number; y: number; text: string }) {
  // Approximate background rect by length of text (7px per char)
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
        fill="#1E1E25"
      />
      <text
        x={x}
        y={y + 3}
        textAnchor="middle"
        fontSize="10"
        fontFamily="'IBM Plex Mono', ui-monospace, monospace"
        fill="var(--color-text-secondary)"
      >
        {text}
      </text>
    </g>
  );
}
