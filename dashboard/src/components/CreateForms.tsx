import { useState } from "react";
import * as api from "../api";
import { Button } from "./ui/Button";
import { PlusIcon } from "./ui/Icon";

interface Props {
  projectId: string;
  onCreated: () => void;
}

/** Action-bar row above the Kanban board. The inline form drops in below
 *  the button row when either toggle is open. */
export function CreateForms({ projectId, onCreated }: Props) {
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);

  return (
    <div className="create-forms flex flex-col">
      <div className="form-buttons flex h-12 items-center gap-3 px-6 bg-bg-surface border-b border-border-subtle">
        {projectId && (
          <span data-tour="kanban.create-task">
            <Button
              variant="primary-red"
              aria-label="+ Task"
              onClick={() => setShowTaskForm((v) => !v)}
              leadingIcon={<PlusIcon size={14} />}
            >
              Task
            </Button>
          </span>
        )}
        <span data-tour="kanban.create-project">
          <Button
            variant="secondary"
            aria-label="+ Project"
            onClick={() => setShowProjectForm((v) => !v)}
            leadingIcon={<PlusIcon size={14} />}
          >
            Project
          </Button>
        </span>
      </div>

      {showProjectForm && (
        <div className="px-6 py-3 bg-bg-surface border-b border-border-subtle">
          <ProjectForm onCreated={() => { setShowProjectForm(false); onCreated(); }} />
        </div>
      )}

      {showTaskForm && projectId && (
        <div className="px-6 py-3 bg-bg-surface border-b border-border-subtle">
          <TaskForm projectId={projectId} onCreated={() => { setShowTaskForm(false); onCreated(); }} />
        </div>
      )}
    </div>
  );
}

function ProjectForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [localPath, setLocalPath] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await api.createProject({ name, localPath: localPath || undefined });
    setName("");
    setLocalPath("");
    onCreated();
  };

  return (
    <form className="inline-form flex items-center gap-2 flex-wrap" onSubmit={handleSubmit}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" required className={INPUT_CLS} />
      <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="Local path (e.g. /Users/you/myapp)" className={INPUT_CLS} style={{ minWidth: 260 }} />
      <Button variant="primary-red" type="submit">Create Project</Button>
    </form>
  );
}

function TaskForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("task");
  const [priority, setPriority] = useState("normal");
  const [assigneeRole, setAssigneeRole] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    await api.createTask({
      projectId,
      title,
      type: type as "task",
      priority: priority as "normal",
      assigneeRole: assigneeRole || undefined,
    });
    setTitle("");
    onCreated();
  };

  return (
    <form className="inline-form flex items-center gap-2 flex-wrap" onSubmit={handleSubmit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" required className={INPUT_CLS} />
      <select value={type} onChange={(e) => setType(e.target.value)} className={INPUT_CLS}>
        {["epic", "task", "subtask", "bug", "feature"].map((t) => <option key={t}>{t}</option>)}
      </select>
      <select value={priority} onChange={(e) => setPriority(e.target.value)} className={INPUT_CLS}>
        {["low", "normal", "high", "immediate"].map((p) => <option key={p}>{p}</option>)}
      </select>
      <select value={assigneeRole} onChange={(e) => setAssigneeRole(e.target.value)} className={INPUT_CLS}>
        <option value="">Unassigned</option>
        {["tech-lead", "designer", "frontend", "backend", "qa", "devops"].map((r) => <option key={r}>{r}</option>)}
      </select>
      <Button variant="primary-red" type="submit">Create Task</Button>
    </form>
  );
}

const INPUT_CLS =
  "h-8 px-3 bg-bg-input border border-border text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-red";
