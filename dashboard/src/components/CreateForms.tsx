import { useState } from "react";
import { api } from "../api";
import type { Project } from "../types";

interface CreateProjectProps {
  onCreated: () => void;
}

export function CreateProjectForm({ onCreated }: CreateProjectProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      await api.createProject(name.trim(), description.trim() || undefined);
      setName("");
      setDescription("");
      setOpen(false);
      onCreated();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button className="btn-action" onClick={() => setOpen(true)}>
        + New Project
      </button>
    );
  }

  return (
    <div className="form-inline">
      <input
        placeholder="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <input
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <button className="btn-action" onClick={submit} disabled={loading}>
        {loading ? "..." : "Create"}
      </button>
      <button className="btn-cancel" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

interface CreateTaskProps {
  projectId: string;
  onCreated: () => void;
}

export function CreateTaskForm({ projectId, onCreated }: CreateTaskProps) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("Task");
  const [priority, setPriority] = useState("Normal");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!subject.trim()) return;
    setLoading(true);
    try {
      await api.createTask({
        projectId,
        subject: subject.trim(),
        description: description.trim() || undefined,
        type,
        priority,
      });
      setSubject("");
      setDescription("");
      setType("Task");
      setPriority("Normal");
      setOpen(false);
      onCreated();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button className="btn-action" onClick={() => setOpen(true)}>
        + New Task
      </button>
    );
  }

  return (
    <div className="form-card">
      <input
        placeholder="Task title"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        autoFocus
      />
      <textarea
        placeholder="Description (markdown)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
      />
      <div className="form-row">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option>Epic</option>
          <option>Task</option>
          <option>Subtask</option>
          <option>Bug</option>
          <option>Feature</option>
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option>Low</option>
          <option>Normal</option>
          <option>High</option>
          <option>Immediate</option>
        </select>
      </div>
      <div className="form-row">
        <button className="btn-action" onClick={submit} disabled={loading}>
          {loading ? "Creating..." : "Create Task"}
        </button>
        <button className="btn-cancel" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

interface ProjectSelectorProps {
  projects: Project[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
}

export function ProjectSelector({ projects, selected, onSelect, onRefresh }: ProjectSelectorProps) {
  return (
    <div className="project-selector">
      <select
        value={selected || ""}
        onChange={(e) => onSelect(e.target.value || null)}
      >
        <option value="">All Projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <CreateProjectForm onCreated={onRefresh} />
    </div>
  );
}
