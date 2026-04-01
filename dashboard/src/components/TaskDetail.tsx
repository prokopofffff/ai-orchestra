import { useState, useCallback } from "react";
import { usePolling } from "../hooks/usePolling";
import * as api from "../api";
import type { Task, TaskComment, TaskState } from "../types";
import { ROLE_COLORS } from "../types";

const ALL_STATES: TaskState[] = [
  "new", "described", "designing", "design_ready",
  "in_development", "pr_created", "in_testing", "tested",
  "in_review", "approved", "merged", "closed",
];

const ALL_ROLES = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"];

interface Props {
  taskId: string;
  onClose: () => void;
}

export function TaskDetail({ taskId, onClose }: Props) {
  const taskFetcher = useCallback(() => api.fetchTask(taskId), [taskId]);
  const commentsFetcher = useCallback(() => api.fetchComments(taskId), [taskId]);

  const { data: task, refresh: refreshTask } = usePolling(taskFetcher, 5000);
  const { data: comments, refresh: refreshComments } = usePolling(commentsFetcher, 5000);

  const [newComment, setNewComment] = useState("");

  if (!task) return null;

  const handleUpdate = async (updates: Partial<Task>) => {
    await api.updateTask(taskId, updates);
    refreshTask();
  };

  const handleAddComment = async () => {
    if (!newComment.trim()) return;
    await api.addComment(taskId, "user", newComment);
    setNewComment("");
    refreshComments();
  };

  const handleDelete = async () => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    await api.deleteTask(taskId);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{task.title}</h2>
          <button className="close-btn" onClick={onClose}>x</button>
        </div>

        <div className="modal-body">
          <div className="field-row">
            <label>State</label>
            <select value={task.state} onChange={(e) => handleUpdate({ state: e.target.value as TaskState })}>
              {ALL_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="field-row">
            <label>Priority</label>
            <select value={task.priority} onChange={(e) => handleUpdate({ priority: e.target.value as Task["priority"] })}>
              {["low", "normal", "high", "immediate"].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <div className="field-row">
            <label>Assignee</label>
            <select value={task.assigneeRole ?? ""} onChange={(e) => handleUpdate({ assigneeRole: e.target.value || null })}>
              <option value="">Unassigned</option>
              {ALL_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>

          <div className="field-row">
            <label>Type</label>
            <select value={task.type} onChange={(e) => handleUpdate({ type: e.target.value as Task["type"] })}>
              {["epic", "task", "subtask", "bug", "feature"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {task.branchName && (
            <div className="field-row">
              <label>Branch</label>
              <code>{task.branchName}</code>
            </div>
          )}

          {task.prUrl && (
            <div className="field-row">
              <label>PR</label>
              <a href={task.prUrl} target="_blank" rel="noopener">{task.prUrl}</a>
            </div>
          )}

          {task.blockedBy.length > 0 && (
            <div className="field-row">
              <label>Blocked by</label>
              <span>{task.blockedBy.length} task(s)</span>
            </div>
          )}

          <div className="description">
            <label>Description</label>
            <textarea
              value={task.description ?? ""}
              onChange={(e) => handleUpdate({ description: e.target.value })}
              rows={4}
            />
          </div>

          <div className="comments">
            <h3>Comments ({comments?.length ?? 0})</h3>
            {comments?.map((c) => (
              <div key={c.id} className="comment">
                <strong style={{ color: ROLE_COLORS[c.author] ?? "#666" }}>{c.author}</strong>
                <span className="comment-time">{new Date(c.createdAt).toLocaleString()}</span>
                <p>{c.body}</p>
              </div>
            ))}
            <div className="comment-form">
              <input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Add comment..."
                onKeyDown={(e) => e.key === "Enter" && handleAddComment()}
              />
              <button onClick={handleAddComment}>Send</button>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="delete-btn" onClick={handleDelete}>Delete Task</button>
        </div>
      </div>
    </div>
  );
}
