import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import type { AuditEntry } from "../types";
import { ROLE_COLORS, ROLE_FALLBACK } from "../types";
import { ArrowRightIcon } from "./ui/Icon";

type Filter = "all" | "webhook" | "task" | "agent";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all",     label: "All"     },
  { id: "webhook", label: "Webhook" },
  { id: "task",    label: "Task"    },
  { id: "agent",   label: "Agent"   },
];

interface Props {
  projectId: string;
}

export function SignalFeed({ projectId }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const { data: entries } = useQuery({
    queryKey: ["audit", projectId],
    queryFn: () => api.fetchAudit(projectId, 100),
    refetchInterval: 5_000,
  });

  if (!entries) return <div className="loading p-5 text-text-secondary">Loading signals…</div>;

  const filtered = entries.filter((e) => matchesFilter(e, filter));

  return (
    <div className="signal-feed flex flex-col gap-5 p-10">
      <header className="flex items-center justify-between">
        <h2 className="text-[22px] font-semibold tracking-tight text-text-primary">
          Signal Feed
        </h2>
        <LiveChip />
      </header>

      <div className="flex items-center gap-2.5">
        {FILTERS.map((f) => (
          <FilterChip
            key={f.id}
            label={f.label}
            active={filter === f.id}
            onClick={() => setFilter(f.id)}
          />
        ))}
      </div>

      <ul className="signal-list flex flex-col gap-3">
        {filtered.map((e) => <SignalEntry key={e.id} entry={e} />)}
        {filtered.length === 0 && (
          <li className="empty text-text-tertiary italic">No signals yet</li>
        )}
      </ul>
    </div>
  );
}

function matchesFilter(entry: AuditEntry, filter: Filter): boolean {
  if (filter === "all") return true;
  const a = entry.action.toLowerCase();
  if (filter === "webhook") return a.includes("webhook") || a.includes("pr_") || a.includes("tests_");
  if (filter === "task")    return a.includes("task") || a.includes("assign") || a.includes("design") || a === "merge";
  if (filter === "agent")   return a.includes("agent") || entry.fromRole !== "system";
  return true;
}

function LiveChip() {
  return (
    <span
      className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border"
      style={{
        backgroundColor: "rgba(34, 197, 94, 0.125)",
        borderColor: "rgba(34, 197, 94, 0.125)",
      }}
    >
      <span className="h-2 w-2 rounded-full bg-accent-green" />
      <span className="font-mono text-[11px] text-accent-green uppercase tracking-wider">
        Live
      </span>
    </span>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "px-3.5 py-1.5 text-[11px] font-medium transition-colors",
        active
          ? "bg-accent-blue text-white"
          : "bg-bg-surface text-text-secondary border border-border hover:text-text-primary",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function SignalEntry({ entry }: { entry: AuditEntry }) {
  const isRejected = entry.status === "rejected";
  const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <li
      className={[
        "signal-entry",
        isRejected ? "rejected" : "allowed",
        "bg-bg-surface border border-border-subtle px-5 py-4 flex flex-col gap-3.5",
        isRejected && "border-l-[3px] border-l-accent-red",
      ].filter(Boolean).join(" ")}
    >
      <div className="signal-header flex items-center gap-3 text-[11px] text-text-tertiary font-mono">
        <span className="signal-time">{time}</span>
        <span
          className={[
            "signal-status px-2 py-0.5 uppercase tracking-wider font-semibold",
            isRejected
              ? "text-accent-red bg-accent-red/10"
              : "text-accent-green bg-accent-green/10",
            entry.status,
          ].join(" ")}
        >
          {entry.status}
        </span>
      </div>

      <div className="signal-route flex items-center gap-2 text-sm">
        <RoleBadge role={entry.fromRole} />
        <ArrowRightIcon size={14} className="signal-arrow text-text-tertiary" />
        <RoleBadge role={entry.toRole} />
        <span className="signal-action ml-2 font-mono text-xs px-2 py-0.5 bg-bg-input text-text-primary">
          {entry.action}
        </span>
      </div>

      {isRejected && entry.reason && (
        <div className="signal-reason text-[13px] text-accent-red">
          {entry.reason}
        </div>
      )}
    </li>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span
      className="signal-role font-semibold text-[13px]"
      style={{ color: ROLE_COLORS[role] ?? ROLE_FALLBACK }}
    >
      {role}
    </span>
  );
}
