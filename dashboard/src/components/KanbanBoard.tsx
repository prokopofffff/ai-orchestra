import type { Task } from "../types";

interface Props {
  tasks: Task[];
}

interface KanbanColumn {
  label: string;
  states: string[];
  color: string;
}

const COLUMNS: KanbanColumn[] = [
  { label: "Backlog", states: ["new", "described"], color: "#6b7280" },
  { label: "Design", states: ["designing", "design_ready"], color: "#ec4899" },
  { label: "Development", states: ["in_development", "pr_created"], color: "#3b82f6" },
  { label: "Testing", states: ["in_testing", "tested"], color: "#f59e0b" },
  { label: "Review", states: ["in_review", "approved"], color: "#8b5cf6" },
  { label: "Done", states: ["merged", "closed"], color: "#22c55e" },
];

const TYPE_COLORS: Record<string, string> = {
  Epic: "#6366f1",
  Task: "#3b82f6",
  Subtask: "#94a3b8",
  Bug: "#ef4444",
  Feature: "#10b981",
};

const PRIORITY_ICONS: Record<string, string> = {
  Immediate: "!!!",
  High: "!!",
  Normal: "",
  Low: "~",
};

function TaskCard({ task }: { task: Task }) {
  return (
    <div className="kanban-card">
      <div className="kanban-card-header">
        <span
          className="kanban-type"
          style={{ background: TYPE_COLORS[task.type] || "#6b7280" }}
        >
          {task.type}
        </span>
        {PRIORITY_ICONS[task.priority] && (
          <span className="kanban-priority">{PRIORITY_ICONS[task.priority]}</span>
        )}
      </div>
      <div className="kanban-card-subject">{task.subject}</div>
      <div className="kanban-card-footer">
        <span className="kanban-state">{task.state}</span>
        {task.assignee && <span className="kanban-assignee">@{task.assignee}</span>}
      </div>
      {task.done_ratio > 0 && (
        <div className="kanban-progress">
          <div className="kanban-progress-bar" style={{ width: `${task.done_ratio}%` }} />
        </div>
      )}
    </div>
  );
}

export function KanbanBoard({ tasks }: Props) {
  if (tasks.length === 0) {
    return (
      <div className="section">
        <h2>Kanban Board</h2>
        <p className="empty">No tasks yet</p>
      </div>
    );
  }

  return (
    <div className="section">
      <h2>Kanban Board ({tasks.length} tasks)</h2>
      <div className="kanban-columns">
        {COLUMNS.map((col) => {
          const columnTasks = tasks.filter((t) => col.states.includes(t.state));
          return (
            <div key={col.label} className="kanban-column">
              <div className="kanban-column-header" style={{ borderColor: col.color }}>
                <span>{col.label}</span>
                <span className="kanban-count">{columnTasks.length}</span>
              </div>
              <div className="kanban-column-body">
                {columnTasks.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
