import { useCallback } from "react";
import { usePolling } from "../hooks/usePolling";
import * as api from "../api";
import type { Task } from "../types";
import { KANBAN_PHASES, ROLE_COLORS } from "../types";

interface Props {
  projectId: string;
  onTaskClick: (taskId: string) => void;
}

export function KanbanBoard({ projectId, onTaskClick }: Props) {
  const fetcher = useCallback(() => api.fetchTasks(projectId), [projectId]);
  const { data: tasks } = usePolling(fetcher, 5000);

  if (!tasks) return <div className="loading">Loading tasks...</div>;

  return (
    <div className="kanban">
      {Object.entries(KANBAN_PHASES).map(([phase, states]) => {
        const phaseTasks = tasks.filter((t) => (states as readonly string[]).includes(t.state));
        return (
          <div key={phase} className="kanban-column">
            <h3 className="kanban-column-header">
              {phase} <span className="count">{phaseTasks.length}</span>
            </h3>
            <div className="kanban-cards">
              {phaseTasks.map((task) => (
                <TaskCard key={task.id} task={task} tasks={tasks} onClick={() => onTaskClick(task.id)} />
              ))}
            </div>
          </div>
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
    <div
      className={`kanban-card ${isBlocked ? "blocked" : ""} priority-${task.priority}`}
      onClick={onClick}
    >
      <div className="card-header">
        <span className="card-type">{task.type}</span>
        <span className="card-priority">{task.priority}</span>
      </div>
      <div className="card-title">{task.title}</div>
      <div className="card-footer">
        {task.assigneeRole && (
          <span
            className="card-role"
            style={{ backgroundColor: ROLE_COLORS[task.assigneeRole] ?? "#999" }}
          >
            {task.assigneeRole}
          </span>
        )}
        {isBlocked && <span className="card-blocked" title="Blocked by dependencies">blocked</span>}
        <span className="card-state">{task.state}</span>
      </div>
    </div>
  );
}
