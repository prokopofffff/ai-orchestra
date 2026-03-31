import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import type { Task, TaskComment } from "../types";

interface Props {
  task: Task;
  onClose: () => void;
  onUpdated: () => void;
}

const STATES = [
  "new", "described", "designing", "design_ready",
  "in_development", "pr_created", "in_testing", "tested",
  "in_review", "approved", "merged", "closed", "rejected",
];

export function TaskDetail({ task, onClose, onUpdated }: Props) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [editing, setEditing] = useState(false);
  const [editDesc, setEditDesc] = useState(task.description);
  const [loading, setLoading] = useState(false);

  const loadComments = useCallback(async () => {
    try {
      const data = await api.comments(task.id);
      setComments(data);
    } catch {
      // ignore
    }
  }, [task.id]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  const addComment = async () => {
    if (!newComment.trim()) return;
    setLoading(true);
    try {
      await api.addComment(task.id, "user", newComment.trim());
      setNewComment("");
      await loadComments();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const updateState = async (state: string) => {
    try {
      await api.updateTask(task.id, { state });
      onUpdated();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const saveDescription = async () => {
    try {
      await api.updateTask(task.id, { description: editDesc });
      setEditing(false);
      onUpdated();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const updateField = async (field: string, value: unknown) => {
    try {
      await api.updateTask(task.id, { [field]: value });
      onUpdated();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="modal-type" style={{ background: typeColor(task.type) }}>
              {task.type}
            </span>
            <span className="modal-id">#{task.id.substring(0, 8)}</span>
          </div>
          <button className="btn-close" onClick={onClose}>x</button>
        </div>

        <h2 className="modal-title">{task.subject}</h2>

        <div className="modal-meta">
          <div className="meta-row">
            <label>State:</label>
            <select value={task.state} onChange={(e) => updateState(e.target.value)}>
              {STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="meta-row">
            <label>Priority:</label>
            <select
              value={task.priority}
              onChange={(e) => updateField("priority", e.target.value)}
            >
              <option>Low</option>
              <option>Normal</option>
              <option>High</option>
              <option>Immediate</option>
            </select>
          </div>
          <div className="meta-row">
            <label>Assignee:</label>
            <select
              value={task.assignee || ""}
              onChange={(e) => updateField("assignee", e.target.value || null)}
            >
              <option value="">Unassigned</option>
              <option value="tech-lead">Tech Lead</option>
              <option value="designer">Designer</option>
              <option value="frontend">Frontend</option>
              <option value="backend">Backend</option>
              <option value="qa">QA</option>
              <option value="devops">DevOps</option>
            </select>
          </div>
          <div className="meta-row">
            <label>Progress:</label>
            <input
              type="range"
              min={0}
              max={100}
              step={10}
              value={task.done_ratio}
              onChange={(e) => updateField("doneRatio", parseInt(e.target.value))}
            />
            <span>{task.done_ratio}%</span>
          </div>
        </div>

        <div className="modal-section">
          <div className="section-header">
            <h3>Description</h3>
            {!editing && (
              <button className="btn-small" onClick={() => { setEditing(true); setEditDesc(task.description); }}>
                Edit
              </button>
            )}
          </div>
          {editing ? (
            <div>
              <textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                rows={6}
                className="modal-textarea"
              />
              <div className="form-row">
                <button className="btn-action" onClick={saveDescription}>Save</button>
                <button className="btn-cancel" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <p className="modal-desc">{task.description || "No description"}</p>
          )}
        </div>

        <div className="modal-section">
          <h3>Comments ({comments.length})</h3>
          <div className="comments-list">
            {comments.map((c) => (
              <div key={c.id} className="comment">
                <div className="comment-header">
                  <strong>{c.author}</strong>
                  <span className="comment-time">
                    {new Date(c.created_at).toLocaleString()}
                  </span>
                </div>
                <div className="comment-body">{c.comment}</div>
              </div>
            ))}
          </div>
          <div className="comment-form">
            <textarea
              placeholder="Add a comment..."
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              rows={2}
            />
            <button className="btn-action" onClick={addComment} disabled={loading}>
              {loading ? "..." : "Comment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function typeColor(type: string): string {
  const colors: Record<string, string> = {
    Epic: "#6366f1", Task: "#3b82f6", Subtask: "#94a3b8", Bug: "#ef4444", Feature: "#10b981",
  };
  return colors[type] || "#6b7280";
}
