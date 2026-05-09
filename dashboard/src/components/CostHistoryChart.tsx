import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { useProjectContext } from "../contexts/ProjectContext";
import { ROLE_COLORS, ROLE_FALLBACK } from "../types";

type Range = 7 | 30;

/**
 * Stacked-bar history of project spend. SVG-only, no chart lib — keeps the
 * dashboard bundle small. Hover surfaces per-role totals for that day.
 */
export function CostHistoryChart() {
  const { project } = useProjectContext();
  const [range, setRange] = useState<Range>(7);
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  const { data } = useQuery({
    queryKey: ["usage-series", project?.id, range],
    queryFn: () => api.fetchUsageSeries(project!.id, range),
    enabled: !!project,
    refetchInterval: 60_000,
  });

  if (!project || !data) return null;

  const days = data.days;
  if (!days.length) return null;

  // Stable role ordering across days for stack consistency.
  const allRoles = Array.from(new Set(days.flatMap((d) => Object.keys(d.byRole)))).sort();
  const max = Math.max(0.01, ...days.map((d) => d.total));

  const W = 560;
  const H = 160;
  const PAD_L = 32;
  const PAD_R = 8;
  const PAD_T = 8;
  const PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const barW = innerW / days.length * 0.78;
  const step = innerW / days.length;

  const grandTotal = days.reduce((a, d) => a + d.total, 0);
  const hoverEntry = hoverDay != null ? days[hoverDay] : null;

  return (
    <section className="cost-history flex flex-col gap-3 bg-bg-surface border border-border p-4">
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">Cost history</h3>
        <div className="flex items-center gap-1">
          {([7, 30] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={[
                "px-2 py-0.5 text-[11px] font-mono border transition-colors",
                range === r
                  ? "border-accent-blue text-text-primary"
                  : "border-border text-text-tertiary hover:text-text-primary",
              ].join(" ")}
            >
              {r}d
            </button>
          ))}
        </div>
      </header>

      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold text-text-primary">${grandTotal.toFixed(2)}</span>
        <span className="text-[11px] font-mono text-text-tertiary">
          {hoverEntry ? `${hoverEntry.day} · $${hoverEntry.total.toFixed(2)}` : `${range} days · max $${max.toFixed(2)}/day`}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
        {/* Y-axis label at top */}
        <text x={4} y={PAD_T + 8} className="fill-text-tertiary" fontSize={9} fontFamily="monospace">
          ${max.toFixed(2)}
        </text>
        <text x={4} y={H - PAD_B + 4} className="fill-text-tertiary" fontSize={9} fontFamily="monospace">$0</text>
        {/* Baseline */}
        <line
          x1={PAD_L} x2={W - PAD_R} y1={H - PAD_B} y2={H - PAD_B}
          className="stroke-border" strokeWidth={1}
        />
        {days.map((d, i) => {
          const x = PAD_L + step * i + (step - barW) / 2;
          let yCursor = H - PAD_B;
          return (
            <g
              key={d.day}
              onMouseEnter={() => setHoverDay(i)}
              onMouseLeave={() => setHoverDay(null)}
            >
              {/* Hover hit area covers the full column */}
              <rect
                x={PAD_L + step * i} y={PAD_T}
                width={step} height={innerH}
                fill="transparent"
              />
              {allRoles.map((role) => {
                const cost = d.byRole[role] ?? 0;
                if (cost <= 0) return null;
                const h = (cost / max) * innerH;
                const y = yCursor - h;
                yCursor = y;
                return (
                  <rect
                    key={role}
                    x={x} y={y}
                    width={barW} height={Math.max(1, h)}
                    fill={ROLE_COLORS[role] ?? ROLE_FALLBACK}
                    opacity={hoverDay == null || hoverDay === i ? 1 : 0.4}
                  />
                );
              })}
              {/* X-axis label every 2nd day for 7d, every 5th for 30d */}
              {(range === 7 || i % 5 === 0 || i === days.length - 1) && (
                <text
                  x={PAD_L + step * i + step / 2}
                  y={H - 6}
                  textAnchor="middle"
                  fontSize={9}
                  fontFamily="monospace"
                  className="fill-text-tertiary"
                >
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Role legend — only roles that appear */}
      {allRoles.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          {allRoles.map((role) => {
            const total = days.reduce((a, d) => a + (d.byRole[role] ?? 0), 0);
            return (
              <span key={role} className="flex items-center gap-1.5">
                <span
                  className="inline-block w-2 h-2"
                  style={{ background: ROLE_COLORS[role] ?? ROLE_FALLBACK }}
                />
                <span style={{ color: ROLE_COLORS[role] ?? ROLE_FALLBACK }}>{role}</span>
                <span className="font-mono text-text-tertiary">${total.toFixed(2)}</span>
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}
