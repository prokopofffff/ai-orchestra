import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import type { Task } from "../types";
import { KANBAN_PHASES, ROLE_COLORS, ROLE_FALLBACK } from "../types";

interface Props {
  projectId: string;
  onTaskClick: (taskId: string) => void;
}

const PHASE_ACCENT: Record<string, string> = {
  Done: "text-accent-green",
  Blocked: "text-accent-red",
};

export function KanbanBoard({ projectId, onTaskClick }: Props) {
  const { data: tasks } = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => api.fetchTasks(projectId),
    refetchInterval: 5_000,
  });

  if (!tasks) {
    return <div className="loading p-5 text-text-secondary">Loading tasks…</div>;
  }

  return (
    <div className="kanban flex gap-3 overflow-x-auto min-h-0 flex-1">
      {Object.entries(KANBAN_PHASES).map(([phase, states]) => {
        const phaseTasks = tasks.filter((t) => (states as readonly string[]).includes(t.state));
        const accent = PHASE_ACCENT[phase] ?? "text-text-secondary";
        return (
          <section
            key={phase}
            className="kanban-column flex-1 min-w-[200px] flex flex-col gap-[10px] bg-bg-surface border border-border-subtle p-[10px] pt-3"
          >
            <h3
              className={[
                "kanban-column-header flex items-center justify-between",
                "font-mono text-[11px] font-semibold uppercase tracking-[1px]",
                accent,
              ].join(" ")}
            >
              <span>{phase}</span>
              <span className="count bg-bg-hover text-text-secondary px-2 py-0.5 text-[11px]">
                {phaseTasks.length}
              </span>
            </h3>
            <div className="kanban-cards flex flex-col gap-2 min-h-0">
              {phaseTasks.map((t) => (
                <TaskCard key={t.id} task={t} tasks={tasks} onClick={() => onTaskClick(t.id)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({ task, tasks, onClick }: { task: Task; tasks: Task[]; onClick: () => void }) {
  const isBlocked = task.blockedBy.some((id) => {
    const blocker = tasks.find((t) => t.id === id);
    return blocker && blocker.state !== "merged" && blocker.state !== "closed";
  });

  return (
    <article
      onClick={onClick}
      className={[
        "kanban-card",
        `priority-${task.priority}`,
        isBlocked && "blocked",
        "group cursor-pointer bg-bg-card border border-border p-[10px]",
        "flex flex-col gap-2 transition-colors hover:border-text-tertiary",
        task.priority === "immediate" && "border-l-[3px] border-l-accent-red",
        task.priority === "high"      && "border-l-[3px] border-l-accent-yellow",
        isBlocked && "opacity-70",
      ].filter(Boolean).join(" ")}
    >
      <div className="card-header flex items-center justify-between font-mono text-[10px] text-text-tertiary">
        <span className="card-type">{task.type}</span>
        <span className="card-priority">{task.priority}</span>
      </div>
      <div className="card-title text-[13px] font-medium text-text-primary leading-snug break-words">
        {task.title}
      </div>
      <div className="card-footer flex items-center gap-2 flex-wrap">
        {task.assigneeRole && (
          <span
            className="card-role inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold text-text-on-accent"
            style={{ backgroundColor: ROLE_COLORS[task.assigneeRole] ?? ROLE_FALLBACK }}
          >
            {task.assigneeRole}
          </span>
        )}
        {isBlocked && (
          <span className="card-blocked text-[10px] font-semibold text-accent-yellow" title="Blocked by dependencies">
            blocked
          </span>
        )}
        <span className="card-state ml-auto font-mono text-[10px] text-text-tertiary">
          {task.state}
        </span>
      </div>
    </article>
  );
}
