import { useEffect, useState } from "react";
import * as api from "../api";
import { useProjectContext } from "../contexts/ProjectContext";
import { Button } from "./ui/Button";
import { PlusIcon } from "./ui/Icon";
import { FolderPicker } from "./FolderPicker";
import { TokenHelp } from "./TokenHelp";

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
              aria-label="+ Задача"
              onClick={() => setShowTaskForm((v) => !v)}
              leadingIcon={<PlusIcon size={14} />}
            >
              Задача
            </Button>
          </span>
        )}
        <span data-tour="kanban.create-project">
          <Button
            variant="secondary"
            aria-label="+ Проект"
            onClick={() => setShowProjectForm((v) => !v)}
            leadingIcon={<PlusIcon size={14} />}
          >
            Проект
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

type SourceMode = "existing" | "clone";

function ProjectForm({ onCreated }: { onCreated: () => void }) {
  const { createProject } = useProjectContext();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<SourceMode>("existing");
  const [localPath, setLocalPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [token, setToken] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When clone is in flight, projectId + poll loop drive a progress message
  // until the worker reports success / error.
  const [cloneProjectId, setCloneProjectId] = useState<string | null>(null);
  const [cloneStatus, setCloneStatus] = useState<api.CloneStatus | null>(null);

  // Poll clone status every 1.5s while the worker is running.
  useEffect(() => {
    if (!cloneProjectId || cloneStatus?.state !== "running") return;
    const t = setInterval(async () => {
      try {
        const s = await api.fetchProjectCloneStatus(cloneProjectId);
        setCloneStatus(s);
        if (s.state === "success") {
          onCreated();
        }
      } catch (e) {
        setError(`Не удалось получить статус клона: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 1500);
    return () => clearInterval(t);
  }, [cloneProjectId, cloneStatus?.state, onCreated]);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return;
    if (!localPath.trim()) {
      setError("Укажите путь");
      return;
    }
    if (mode === "clone" && !repoUrl.trim()) {
      setError("Укажите URL репозитория для клонирования");
      return;
    }

    setSubmitting(true);
    try {
      const created = await createProject({
        name: name.trim(),
        localPath: localPath.trim(),
        repoUrl: mode === "clone" ? repoUrl.trim() : undefined,
      });
      if (mode === "clone") {
        // Kick off background clone; component switches to progress view.
        const initial = await api.startProjectClone(created.id, {
          repoUrl: repoUrl.trim(),
          token: token.trim() || undefined,
        });
        setCloneProjectId(created.id);
        setCloneStatus(initial);
      } else {
        onCreated();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Once a clone is running / finished, the form is replaced by a status
  // panel — the project row already exists, so closing here means "leave
  // the modal open until clone resolves" rather than "abort".
  if (cloneStatus) {
    return <CloneProgress status={cloneStatus} onDismiss={onCreated} />;
  }

  return (
    <>
      <form className="inline-form flex flex-col gap-3" onSubmit={handleSubmit}>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название проекта"
            required
            className={INPUT_CLS}
            style={{ minWidth: 200 }}
          />
          <RadioPill
            checked={mode === "existing"}
            onChange={() => setMode("existing")}
            label="Использовать существующий путь"
          />
          <RadioPill
            checked={mode === "clone"}
            onChange={() => setMode("clone")}
            label="Склонировать из URL"
          />
        </div>

        {mode === "clone" && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/me/myapp"
                className={INPUT_CLS}
                style={{ minWidth: 280 }}
                required
              />
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Токен (необязательно для public)"
                className={INPUT_CLS}
                style={{ minWidth: 220 }}
                type="password"
                autoComplete="off"
              />
            </div>
            <TokenHelp kind="git-pat" />
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder={
              mode === "clone"
                ? "Куда клонировать (должна быть НЕ существующей папкой)"
                : "Путь к существующему git-репо"
            }
            className={INPUT_CLS}
            style={{ minWidth: 320 }}
            required
          />
          <Button variant="secondary" size="md" type="button" onClick={() => setPickerOpen(true)}>
            Обзор…
          </Button>
          <Button variant="primary-red" type="submit" disabled={submitting}>
            {submitting ? "Создание…" : "Создать проект"}
          </Button>
        </div>

        {error && <span className="text-xs text-accent-red">{error}</span>}
      </form>

      {pickerOpen && (
        <FolderPicker
          initialPath={localPath || undefined}
          onSelect={(p) => setLocalPath(p)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </>
  );
}

function RadioPill({
  checked, onChange, label,
}: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer select-none">
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        className="accent-accent-red"
      />
      {label}
    </label>
  );
}

function CloneProgress({
  status, onDismiss,
}: { status: api.CloneStatus; onDismiss: () => void }) {
  if (status.state === "running") {
    return (
      <div className="flex items-center gap-3 text-xs text-text-secondary">
        <span className="thinking-dots inline-flex gap-1" aria-hidden="true">
          <span className="dot h-1.5 w-1.5 rounded-full bg-text-tertiary animate-pulse" />
          <span className="dot h-1.5 w-1.5 rounded-full bg-text-tertiary animate-pulse" style={{ animationDelay: "150ms" }} />
          <span className="dot h-1.5 w-1.5 rounded-full bg-text-tertiary animate-pulse" style={{ animationDelay: "300ms" }} />
        </span>
        <span>Клонирование репозитория…</span>
      </div>
    );
  }
  if (status.state === "success") {
    return (
      <div className="flex items-center gap-3 text-xs">
        <span className="text-accent-green">✓ Готово</span>
        <Button variant="secondary" size="sm" onClick={onDismiss} type="button">Закрыть</Button>
      </div>
    );
  }
  if (status.state === "error") {
    return (
      <div className="flex items-start gap-3 text-xs">
        <div className="flex flex-col gap-1">
          <span className="text-accent-red font-medium">Не удалось склонировать</span>
          <span className="text-text-secondary font-mono whitespace-pre-wrap">{status.error}</span>
        </div>
        <Button variant="secondary" size="sm" onClick={onDismiss} type="button">Закрыть</Button>
      </div>
    );
  }
  return null;
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
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название задачи" required className={INPUT_CLS} />
      <select value={type} onChange={(e) => setType(e.target.value)} className={INPUT_CLS}>
        {["epic", "task", "subtask", "bug", "feature"].map((t) => <option key={t}>{t}</option>)}
      </select>
      <select value={priority} onChange={(e) => setPriority(e.target.value)} className={INPUT_CLS}>
        {["low", "normal", "high", "immediate"].map((p) => <option key={p}>{p}</option>)}
      </select>
      <select value={assigneeRole} onChange={(e) => setAssigneeRole(e.target.value)} className={INPUT_CLS}>
        <option value="">Не назначен</option>
        {["tech-lead", "designer", "frontend", "backend", "qa", "devops"].map((r) => <option key={r}>{r}</option>)}
      </select>
      <Button variant="primary-red" type="submit">Создать задачу</Button>
    </form>
  );
}

const INPUT_CLS =
  "h-8 px-3 bg-bg-input border border-border text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-red";
