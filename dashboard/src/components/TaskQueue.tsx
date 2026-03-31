import type { QueuedTask } from "../types";

interface Props {
  tasks: QueuedTask[];
}

export function TaskQueue({ tasks }: Props) {
  if (tasks.length === 0) return null;

  return (
    <div className="section">
      <h2>Task Queue ({tasks.length})</h2>
      <div className="queue-list">
        {tasks.map((t) => (
          <div key={t.id} className="queue-entry">
            <span className="queue-role">{t.role}</span>
            <span className="queue-priority">P{t.priority}</span>
            <span className="queue-prompt">
              {t.prompt.substring(0, 80)}
              {t.prompt.length > 80 ? "..." : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
