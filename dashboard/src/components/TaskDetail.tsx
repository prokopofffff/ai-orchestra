import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type { Task, TaskState } from "../types";
import { ROLE_COLORS, ROLE_FALLBACK } from "../types";
import { Button } from "./ui/Button";

const ALL_STATES: TaskState[] = [
  "new", "described", "designing", "design_ready",
  "in_development", "pr_created", "revisions",
  "in_testing", "tested",
  "in_review", "approved", "merged", "closed",
  "failed", "cancelled",
];

const ALL_ROLES = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"];

interface Props {
  taskId: string;
  onClose: () => void;
}

const FIELD_INPUT =
  "h-8 px-3 bg-bg-input border border-border text-xs text-text-primary focus:outline-none focus:border-accent-blue";

export function TaskDetail({ taskId, onClose }: Props) {
  const queryClient = useQueryClient();
  const taskKey = ["task", taskId];
  const commentsKey = ["comments", taskId];

  const { data: task } = useQuery({
    queryKey: taskKey,
    queryFn: () => api.fetchTask(taskId),
    refetchInterval: 5_000,
  });
  const { data: comments } = useQuery({
    queryKey: commentsKey,
    queryFn: () => api.fetchComments(taskId),
    refetchInterval: 5_000,
  });

  const [newComment, setNewComment] = useState("");

  if (!task) return null;

  const handleUpdate = async (updates: Partial<Task>) => {
    await api.updateTask(taskId, updates);
    await queryClient.invalidateQueries({ queryKey: taskKey });
  };

  const handleAddComment = async () => {
    if (!newComment.trim()) return;
    await api.addComment(taskId, "user", newComment);
    setNewComment("");
    await queryClient.invalidateQueries({ queryKey: commentsKey });
  };

  const handleDelete = async () => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    await api.deleteTask(taskId);
    onClose();
  };

  return (
    <div
      className="modal-overlay fixed inset-0 z-50 bg-black/70 grid place-items-center p-6"
      onClick={onClose}
    >
      <div
        className="modal bg-bg-surface border border-border w-full max-w-[600px] max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">{task.title}</h2>
          <button
            className="close-btn text-text-tertiary hover:text-text-primary text-xl leading-none"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal-body flex flex-col gap-3 p-6">
          {task.frozenReason && (
            <FrozenBanner taskId={taskId} reason={task.frozenReason} />
          )}
          {(task.revisionsCount || task.failedCount || task.signalsCount) ? (
            <div className="flex flex-wrap gap-3 text-[11px] font-mono text-text-tertiary">
              {!!task.revisionsCount && <span>revisions: {task.revisionsCount}</span>}
              {!!task.failedCount && <span>failed: {task.failedCount}</span>}
              {!!task.signalsCount && <span>signals: {task.signalsCount}</span>}
            </div>
          ) : null}
          <Row label="State">
            <select className={FIELD_INPUT} value={task.state} onChange={(e) => handleUpdate({ state: e.target.value as TaskState })}>
              {ALL_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Row>
          <Row label="Priority">
            <select className={FIELD_INPUT} value={task.priority} onChange={(e) => handleUpdate({ priority: e.target.value as Task["priority"] })}>
              {["low", "normal", "high", "immediate"].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Row>
          <Row label="Assignee">
            <select className={FIELD_INPUT} value={task.assigneeRole ?? ""} onChange={(e) => handleUpdate({ assigneeRole: e.target.value || null })}>
              <option value="">Unassigned</option>
              {ALL_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Row>
          <Row label="Type">
            <select className={FIELD_INPUT} value={task.type} onChange={(e) => handleUpdate({ type: e.target.value as Task["type"] })}>
              {["epic", "task", "subtask", "bug", "feature"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Row>

          {task.branchName && (
            <Row label="Branch">
              <code className="font-mono text-xs bg-bg-input px-2 py-1 text-text-primary">{task.branchName}</code>
            </Row>
          )}

          {task.prUrl && (
            <Row label="PR">
              <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
                <a href={task.prUrl} target="_blank" rel="noopener" className="text-xs text-accent-blue hover:underline break-all min-w-0">
                  {task.prUrl}
                </a>
                <MergeButton taskId={taskId} state={task.state} />
              </div>
            </Row>
          )}

          {task.blockedBy.length > 0 && (
            <Row label="Blocked by">
              <span className="text-xs text-accent-yellow">{task.blockedBy.length} task(s)</span>
            </Row>
          )}

          <div className="description flex flex-col gap-1.5 mt-2">
            <label className="text-xs font-medium text-text-secondary">Description</label>
            <textarea
              className="w-full bg-bg-input border border-border text-sm text-text-primary px-3 py-2 focus:outline-none focus:border-accent-blue resize-y"
              value={task.description ?? ""}
              onChange={(e) => handleUpdate({ description: e.target.value })}
              rows={4}
            />
          </div>

          <div className="comments flex flex-col gap-2 mt-2">
            <h3 className="text-sm font-semibold text-text-primary">
              Comments ({comments?.length ?? 0})
            </h3>
            {comments?.map((c) => (
              <div key={c.id} className="comment bg-bg-input px-3 py-2 flex flex-col gap-1">
                <div className="flex items-center gap-2 text-xs">
                  <strong style={{ color: ROLE_COLORS[c.author] ?? ROLE_FALLBACK }}>{c.author}</strong>
                  <span className="comment-time text-text-tertiary font-mono">
                    {new Date(c.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm text-text-primary">{c.body}</p>
              </div>
            ))}
            <div className="comment-form flex gap-2 mt-1">
              <input
                className="flex-1 h-9 px-3 bg-bg-input border border-border text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add comment…"
                onKeyDown={(e) => e.key === "Enter" && handleAddComment()}
              />
              <Button variant="primary-blue" onClick={handleAddComment}>Send</Button>
            </div>
          </div>
        </div>

        <div className="modal-footer flex items-center justify-end p-4 border-t border-border">
          <Button variant="primary-red" className="delete-btn" onClick={handleDelete}>
            Delete Task
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field-row flex items-center gap-3">
      <label className="text-xs font-medium text-text-secondary w-20 shrink-0">{label}</label>
      {children}
    </div>
  );
}

/**
 * One-shot "merge this PR" action. Hidden once the task lands in merged/closed
 * to avoid double-fires. Surfaces provider refusals (409 from the API) inline
 * so the user sees the exact reason — conflict, branch protection, failing
 * checks — instead of a generic failure toast.
 *
 * On success we don't update task.state ourselves; the GitHub/GitLab webhook
 * + pr-watcher pipeline does that, the same path as auto-merge. We just
 * invalidate the task query to pick up downstream changes when they arrive.
 */
function MergeButton({ taskId, state }: { taskId: string; state: TaskState }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; message: string } | null>(null);

  if (state === "merged" || state === "closed") return null;

  async function merge() {
    if (!confirm("Merge this PR to main now? Squash merge via the provider; no rollback.")) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.mergeTask(taskId);
      setStatus({ kind: "ok", message: `Merged · sha ${r.sha.slice(0, 7)}` });
      await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "err", message: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="primary-green" size="sm" onClick={merge} disabled={busy}>
        {busy ? "Merging…" : "Merge to main"}
      </Button>
      {status && (
        <span
          className={[
            "text-[11px]",
            status.kind === "ok" ? "text-accent-green" : "text-accent-red",
          ].join(" ")}
          role={status.kind === "err" ? "alert" : undefined}
        >
          {status.message}
        </span>
      )}
    </div>
  );
}

function FrozenBanner({ taskId, reason }: { taskId: string; reason: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function unfreeze() {
    if (!confirm("Unfreeze this task? Counters reset to 0; agents resume on the next signal.")) return;
    setBusy(true);
    try {
      await api.unfreezeTask(taskId);
      await queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    } finally { setBusy(false); }
  }
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2 border border-accent-yellow/40 bg-[color:var(--color-accent-yellow,#f59e0b)]/10">
      <div className="flex items-start gap-2 text-xs">
        <span className="font-semibold text-accent-yellow">Frozen</span>
        <span className="text-text-secondary">{reason}</span>
      </div>
      <Button variant="primary-blue" size="sm" onClick={unfreeze} disabled={busy}>
        {busy ? "…" : "Unfreeze"}
      </Button>
    </div>
  );
}
