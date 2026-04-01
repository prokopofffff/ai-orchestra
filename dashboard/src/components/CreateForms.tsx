import { useState } from "react";
import * as api from "../api";

interface Props {
  projectId: string;
  onCreated: () => void;
}

export function CreateForms({ projectId, onCreated }: Props) {
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);

  return (
    <div className="create-forms">
      <div className="form-buttons">
        {projectId && (
          <button onClick={() => setShowTaskForm(!showTaskForm)}>+ Task</button>
        )}
        <button onClick={() => setShowProjectForm(!showProjectForm)}>+ Project</button>
      </div>

      {showProjectForm && (
        <ProjectForm onCreated={() => { setShowProjectForm(false); onCreated(); }} />
      )}

      {showTaskForm && projectId && (
        <TaskForm projectId={projectId} onCreated={() => { setShowTaskForm(false); onCreated(); }} />
      )}
    </div>
  );
}

function ProjectForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await api.createProject({ name, repoUrl: repoUrl || undefined });
    setName("");
    setRepoUrl("");
    onCreated();
  };

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" required />
      <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="Repo URL (optional)" />
      <button type="submit">Create Project</button>
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
    <form className="inline-form" onSubmit={handleSubmit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" required />
      <select value={type} onChange={(e) => setType(e.target.value)}>
        {["epic", "task", "subtask", "bug", "feature"].map((t) => <option key={t}>{t}</option>)}
      </select>
      <select value={priority} onChange={(e) => setPriority(e.target.value)}>
        {["low", "normal", "high", "immediate"].map((p) => <option key={p}>{p}</option>)}
      </select>
      <select value={assigneeRole} onChange={(e) => setAssigneeRole(e.target.value)}>
        <option value="">Unassigned</option>
        {["tech-lead", "designer", "frontend", "backend", "qa", "devops"].map((r) => <option key={r}>{r}</option>)}
      </select>
      <button type="submit">Create Task</button>
    </form>
  );
}
