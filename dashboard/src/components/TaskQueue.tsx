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
    <section className="task-queue flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-text-primary">Состояние очереди</h3>
      <div className="queue-stats grid grid-cols-4 gap-3">
        <StatCard label="В очереди"  value={status.queued} />
        <StatCard label="Выполняется" value={status.running}   accent="text-accent-green" />
        <StatCard label="Завершено"  value={status.completed} />
        <StatCard label="Ошибки"     value={status.failed}    accent="text-accent-red" />
      </div>
      {status.rateLimited && (
        <div className="queue-rate-limited bg-accent-red text-white text-xs px-3 py-2">
          Лимит запросов до {status.rateLimitResetTime
            ? new Date(status.rateLimitResetTime).toLocaleTimeString()
            : "неизвестно"}
        </div>
      )}
    </section>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="stat flex flex-col items-center bg-bg-surface border border-border px-4 py-3">
      <span className={["stat-value text-2xl font-semibold text-text-primary", accent].filter(Boolean).join(" ")}>
        {value}
      </span>
      <span className="stat-label font-mono text-[10px] uppercase tracking-wider text-text-tertiary mt-1">
        {label}
      </span>
    </div>
  );
}
