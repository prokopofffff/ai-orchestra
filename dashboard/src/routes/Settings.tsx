import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "../contexts/ProjectContext";
import { ProjectChecks } from "../components/ProjectChecks";
import { EmptyProjects } from "../components/EmptyProjects";
import { Button } from "../components/ui/Button";
import { FolderPicker } from "../components/FolderPicker";
import * as api from "../api";
import type { SystemConfig } from "../api";
import type { Project } from "../types";

type Tab = "project" | "agents" | "checks" | "members" | "limits" | "system";

export default function Settings() {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("project");

  if (!project) return <EmptyProjects />;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["projects"] });

  return (
    <div className="settings flex flex-col h-full">
      <nav data-tour="settings.tabs" className="settings-tabs flex items-center gap-0 px-16 border-b border-border bg-bg-surface shrink-0">
        {(["project", "agents", "checks", "members", "limits", "system"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              "h-11 px-4 text-xs font-medium capitalize border-b-2 transition-colors",
              tab === t
                ? "border-accent-blue text-text-primary"
                : "border-transparent text-text-secondary hover:text-text-primary",
            ].join(" ")}
          >
            {t === "project" ? "Project"
              : t === "agents" ? "Agents"
              : t === "checks" ? "Agent Checks"
              : t === "members" ? "Members"
              : t === "limits" ? "Limits"
              : "System"}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        {tab === "project" && (
          <div className="flex flex-col">
            <ProjectTab project={project} onSaved={refresh} />
            <ProjectIntroSection project={project} />
            <ProjectTelegramSection project={project} onSaved={refresh} />
          </div>
        )}
        {tab === "agents" && <AgentsTab project={project} onSaved={refresh} />}
        {tab === "checks" && <ProjectChecks projectId={project.id} />}
        {tab === "members" && <MembersTab projectId={project.id} />}
        {tab === "limits" && <LimitsTab project={project} onSaved={refresh} />}
        {tab === "system" && <SystemTab />}
      </div>
    </div>
  );
}

function ProjectTab({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [repoUrl, setRepoUrl] = useState(project.repoUrl ?? "");
  const [localPath, setLocalPath] = useState(project.localPath ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? "");
    setRepoUrl(project.repoUrl ?? "");
    setLocalPath(project.localPath ?? "");
  }, [project]);

  const hasRepo = repoUrl.trim() || localPath.trim();

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      await api.updateProject(project.id, {
        name: name.trim() || undefined,
        description: description.trim() || null,
        repoUrl: repoUrl.trim() || null,
        localPath: localPath.trim() || null,
      });
      setStatus("Saved");
      onSaved();
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-16 py-12 flex flex-col gap-8 max-w-[700px]">
      <header className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">
            Project Settings
          </h2>
          <p className="text-sm text-text-secondary">
            Configure the repository or local directory agents will work in.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 pt-1">
          {status && <span className="text-xs text-text-tertiary">{status}</span>}
          <Button variant="primary-red" size="lg" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>

      {!hasRepo && (
        <div className="flex items-start gap-3 px-4 py-3 bg-[color:var(--color-accent-red,#e74c3c)]/10 border border-[color:var(--color-accent-red,#e74c3c)]/30 text-xs text-text-secondary">
          <span className="shrink-0 font-semibold text-accent-red mt-0.5">!</span>
          Agents cannot run until you set a repo URL or local path below.
        </div>
      )}

      <section className="flex flex-col gap-5">
        <Field label="Project name">
          <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" />
        </Field>

        <Field label="Description" optional>
          <input className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description" />
        </Field>

        <div className="border-t border-border pt-5 flex flex-col gap-5">
          <p className="text-xs text-text-secondary">
            Set either a remote repository URL <em>or</em> a local directory path. The local path
            is preferred — agents create git worktrees directly from it without cloning.
          </p>

          <Field label="Local directory" hint="Absolute path to a git repo on this machine (e.g. /Users/you/myapp)">
            <div className="flex items-center gap-2">
              <input
                className={INPUT}
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/Users/you/projects/myapp"
              />
              <Button variant="secondary" size="md" type="button" onClick={() => setPickerOpen(true)}>
                Browse…
              </Button>
            </div>
          </Field>
          {pickerOpen && (
            <FolderPicker
              initialPath={localPath || undefined}
              onSelect={(p) => setLocalPath(p)}
              onClose={() => setPickerOpen(false)}
            />
          )}

          <Field label="Remote repo URL" hint="Used when no local path is set — agents clone and work in worktrees">
            <input
              className={INPUT}
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/repo"
            />
          </Field>
        </div>
      </section>
    </div>
  );
}

function ProjectTelegramSection({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const initial = (project.settings as { telegram?: { botToken?: string; chatId?: string } } | undefined)?.telegram;
  const [token, setToken] = useState(initial?.botToken ?? "");
  const [savedToken, setSavedToken] = useState(initial?.botToken ?? "");
  const [savedChatId, setSavedChatId] = useState(initial?.chatId ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Pick up auto-bound chatId once the bot receives /start (poll every 5s
  // while we're waiting for it). Stops once chatId is bound.
  const { data: live } = useQuery({
    queryKey: ["project-telegram", project.id, savedToken],
    queryFn: async () => (await api.fetchProjects()).find((p) => p.id === project.id),
    refetchInterval: savedToken && !savedChatId ? 5_000 : false,
    enabled: !!savedToken,
  });
  useEffect(() => {
    if (!live) return;
    const tg = (live.settings as { telegram?: { chatId?: string } })?.telegram;
    if (tg?.chatId && tg.chatId !== savedChatId) setSavedChatId(tg.chatId);
  }, [live, savedChatId]);

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const tg = token.trim() ? { botToken: token.trim() } : {};
      await api.updateProject(project.id, { settings: { telegram: tg } } as never);
      setSavedToken(token.trim());
      setSavedChatId(""); // wiping the token unbinds the chat
      setStatus(token.trim() ? "Saved — open the bot in Telegram and send /start to bind a chat." : "Telegram disabled for this project.");
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Error: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect Telegram from this project?")) return;
    setSaving(true);
    try {
      await api.updateProject(project.id, { settings: { telegram: { botToken: undefined, chatId: undefined } } } as never);
      setToken("");
      setSavedToken("");
      setSavedChatId("");
      setStatus("Disconnected.");
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="px-16 pb-12 -mt-2 max-w-[700px] flex flex-col gap-4">
      <div className="border-t border-border pt-6 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-text-primary">Telegram</h3>
          <p className="text-xs text-text-secondary">
            Optional. Each project gets its own bot — create one via{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noopener" className="text-accent-blue hover:underline">@BotFather</a>{" "}
            in Telegram, paste the token below, then send <code>/start</code> to the bot. A single bot can't be shared between projects.
          </p>
        </div>
        {savedToken && (
          <Button variant="secondary" size="sm" onClick={disconnect} disabled={saving} type="button">
            Disconnect
          </Button>
        )}
      </div>

      <Field label="Bot token" hint="From @BotFather. Looks like 1234567890:AAH…">
        <div className="flex items-center gap-2">
          <input
            className={INPUT}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="1234567890:AAH…"
            autoComplete="off"
          />
          <Button variant="primary-red" size="md" onClick={save} disabled={saving} type="button">
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </Field>

      {savedToken && (
        <div className="px-3 py-2 border border-border-subtle bg-bg-input text-xs flex items-center gap-2">
          {savedChatId ? (
            <>
              <span className="font-mono text-accent-green">✓</span>
              <span className="text-text-secondary">
                Connected · chat <code className="text-text-primary">{savedChatId}</code> · agent notifications go to Telegram.
              </span>
            </>
          ) : (
            <>
              <span className="font-mono text-accent-yellow">…</span>
              <span className="text-text-secondary">
                Token saved. Send <code className="text-text-primary">/start</code> to the bot in Telegram to bind a chat.
              </span>
            </>
          )}
        </div>
      )}

      {status && <p className="text-xs text-text-tertiary">{status}</p>}
    </section>
  );
}

function ProjectIntroSection({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [rescanning, setRescanning] = useState(false);

  const { data: notes } = useQuery({
    queryKey: ["project-notes", project.id],
    queryFn: () => api.fetchProjectNotes(project.id),
    refetchInterval: 10_000,
  });

  const intro = notes?.find((n) => n.kind === "intro_summary");
  // The intro task is still in flight when there's no note yet AND the
  // project has an intro_task_id pinned. Once the project predates this
  // feature (intro_task_id null) we just show "no scan run".
  const introTaskId = (project as { introTaskId?: string | null }).introTaskId ?? null;
  const inProgress = !intro && !!introTaskId;

  async function rescan() {
    if (!confirm("Run a fresh codebase scan? This spawns a Tech Lead session.")) return;
    setRescanning(true);
    try {
      await api.rescanProject(project.id);
      await queryClient.invalidateQueries({ queryKey: ["project-notes", project.id] });
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    } finally {
      setRescanning(false);
    }
  }

  return (
    <section className="px-16 pb-12 -mt-2 max-w-[700px] flex flex-col gap-4">
      <div className="border-t border-border pt-6 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-text-primary">Codebase intro</h3>
          <p className="text-xs text-text-secondary">
            Tech Lead's first-pass scan of this repository — stack, layout,
            suggested check commands, anything to flag. Updates whenever you
            re-scan.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={rescan} disabled={rescanning} type="button">
          {rescanning ? "Queuing…" : intro ? "Re-scan" : "Scan now"}
        </Button>
      </div>

      {inProgress && (
        <div className="px-3 py-2 border border-border-subtle bg-bg-input text-xs text-text-secondary font-mono">
          Tech Lead is exploring the codebase. The summary will appear here
          when finished.
        </div>
      )}

      {intro && (
        <article className="bg-bg-surface border border-border p-4 text-[13px] leading-relaxed text-text-primary whitespace-pre-wrap font-mono">
          {intro.body}
        </article>
      )}

      {!intro && !inProgress && (
        <div className="text-xs text-text-tertiary">
          No scan run yet. Click <code>Scan now</code> to have Tech Lead
          take a look around.
        </div>
      )}
    </section>
  );
}

const ROLES = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"] as const;
type AgentRole = typeof ROLES[number];

const MODELS = ["opus", "sonnet", "haiku"] as const;
type Model = typeof MODELS[number];

const EFFORTS = ["low", "medium", "high", "max"] as const;
type Effort = typeof EFFORTS[number];

function AgentsTab({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const initial = project.settings as { models?: Record<string, string>; effort?: Record<string, string> };
  const [models, setModels] = useState<Record<AgentRole, string>>(() => {
    const out = {} as Record<AgentRole, string>;
    for (const r of ROLES) out[r] = initial.models?.[r] ?? "";
    return out;
  });
  const [efforts, setEfforts] = useState<Record<AgentRole, string>>(() => {
    const out = {} as Record<AgentRole, string>;
    for (const r of ROLES) out[r] = initial.effort?.[r] ?? "";
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function save() {
    setSaving(true); setStatus(null);
    try {
      const modelsPatch: Record<string, Model> = {};
      const effortPatch: Record<string, Effort> = {};
      for (const r of ROLES) {
        if (models[r]) modelsPatch[r] = models[r] as Model;
        if (efforts[r]) effortPatch[r] = efforts[r] as Effort;
      }
      // PATCH merges into settings (jsonb ||). Empty objects clear nothing —
      // to remove an override the user should set the field to the dropdown's
      // first blank entry, which sends an absent key; on save it gets dropped
      // out of the patch object above.
      await api.updateProject(project.id, {
        settings: { models: modelsPatch, effort: effortPatch },
      } as never);
      setStatus("Saved — takes effect on the next agent run");
      onSaved();
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-16 py-12 flex flex-col gap-8 max-w-[700px]">
      <header className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">Agents</h2>
          <p className="text-sm text-text-secondary">
            Pick a model and effort level per role. Empty = inherit the global
            default. Effort `max` only works on Opus. Higher effort = slower,
            more thorough, more expensive.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 pt-1">
          {status && <span className="text-xs text-text-tertiary">{status}</span>}
          <Button variant="primary-red" size="lg" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-2">
        <div className="grid grid-cols-[120px_1fr_1fr] gap-3 px-3 pb-2 border-b border-border text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
          <span>Role</span>
          <span>Model</span>
          <span>Effort</span>
        </div>
        {ROLES.map((role) => (
          <div key={role} className="grid grid-cols-[120px_1fr_1fr] gap-3 items-center px-3 py-2 border-b border-border-subtle">
            <span className="text-sm text-text-primary font-medium">{role}</span>
            <select
              className={INPUT}
              value={models[role]}
              onChange={(e) => setModels((m) => ({ ...m, [role]: e.target.value }))}
            >
              <option value="">(global default)</option>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select
              className={INPUT}
              value={efforts[role]}
              onChange={(e) => setEfforts((m) => ({ ...m, [role]: e.target.value }))}
            >
              <option value="">(SDK default)</option>
              {EFFORTS.map((eff) => (
                <option key={eff} value={eff} disabled={eff === "max" && models[role] !== "opus"}>
                  {eff}{eff === "max" ? " (Opus only)" : ""}
                </option>
              ))}
            </select>
          </div>
        ))}
      </section>
    </div>
  );
}

function MembersTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => api.fetchProjectMembers(projectId),
  });
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState<"viewer" | "editor" | "admin">("editor");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["project-members", projectId] });

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim()) return;
    setBusy(true); setStatus(null);
    try {
      await api.inviteProjectMember(projectId, identifier.trim(), role);
      setIdentifier("");
      setStatus("Member added");
      refresh();
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    if (!confirm("Remove this member from the project?")) return;
    await api.removeProjectMember(projectId, userId);
    refresh();
  }

  async function changeRole(userId: string, newRole: "viewer" | "editor" | "admin") {
    await api.updateProjectMemberRole(projectId, userId, newRole);
    refresh();
  }

  return (
    <div className="px-16 py-12 flex flex-col gap-8 max-w-[700px]">
      <header className="flex flex-col gap-1">
        <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">Members</h2>
        <p className="text-sm text-text-secondary">
          People with access to this project. Owner has full control.
          Admins can invite and remove. Editors can act on the project.
          Viewers see everything but can't change anything.
        </p>
      </header>

      <form onSubmit={invite} className="flex flex-col gap-3 border border-border bg-bg-surface p-4">
        <h3 className="text-xs font-mono uppercase tracking-wider text-text-tertiary">Invite by username or email</h3>
        <div className="flex gap-2">
          <input
            className={INPUT}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="alice@example.com or alice"
          />
          <select
            className={`${INPUT} w-32`}
            value={role}
            onChange={(e) => setRole(e.target.value as "viewer" | "editor" | "admin")}
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <Button variant="primary-blue" size="md" type="submit" disabled={busy}>
            {busy ? "…" : "Invite"}
          </Button>
        </div>
        {status && <span className="text-xs text-text-tertiary">{status}</span>}
      </form>

      <section className="flex flex-col gap-2">
        {isLoading && <p className="text-sm text-text-tertiary">Loading…</p>}
        {error && <p className="text-sm text-accent-red">Failed to load members.</p>}
        {data?.owner && (
          <MemberRow
            email={data.owner.email}
            username={data.owner.username}
            role="owner"
          />
        )}
        {data?.members.map((m) => (
          <MemberRow
            key={m.userId}
            email={m.email}
            username={m.username}
            role={m.role}
            onRoleChange={(r) => void changeRole(m.userId, r)}
            onRemove={() => void remove(m.userId)}
          />
        ))}
      </section>
    </div>
  );
}

function MemberRow({
  email, username, role,
  onRoleChange, onRemove,
}: {
  email: string;
  username: string;
  role: "owner" | "viewer" | "editor" | "admin";
  onRoleChange?: (r: "viewer" | "editor" | "admin") => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 bg-bg-surface border border-border">
      <div className="flex flex-col">
        <span className="text-sm text-text-primary">{username}</span>
        <span className="text-xs text-text-tertiary">{email}</span>
      </div>
      <div className="flex items-center gap-2">
        {role === "owner" || !onRoleChange ? (
          <span className="text-xs font-mono uppercase text-text-tertiary tracking-wider px-2 py-1 border border-border">
            {role}
          </span>
        ) : (
          <select
            className={`${INPUT} w-28`}
            value={role}
            onChange={(e) => onRoleChange(e.target.value as "viewer" | "editor" | "admin")}
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
        )}
        {onRemove && (
          <Button variant="primary-red" size="sm" onClick={onRemove}>Remove</Button>
        )}
      </div>
    </div>
  );
}

function LimitsTab({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const initial = (project.settings as { limits?: Record<string, unknown> })?.limits ?? {};
  const num = (k: string) => (initial[k] != null ? String(initial[k]) : "");

  const [dailyCostUsd, setDailyCostUsd] = useState(num("dailyCostUsd"));
  const [maxRevisions, setMaxRevisions] = useState(num("maxRevisions"));
  const [maxFails, setMaxFails] = useState(num("maxFails"));
  const [maxSignalsPerTask, setMaxSignalsPerTask] = useState(num("maxSignalsPerTask"));
  const [maxQaDepth, setMaxQaDepth] = useState(num("maxQaDepth"));
  const [maxConcurrentSessions, setMaxConcurrentSessions] = useState(num("maxConcurrentSessions"));
  const [taskHourlyCostUsd, setTaskHourlyCostUsd] = useState(num("taskHourlyCostUsd"));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  function pickNumber(s: string): number | undefined {
    const n = Number(s);
    return s.trim() && Number.isFinite(n) ? n : undefined;
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const limits: Record<string, number> = {};
      const fields: Array<[string, string]> = [
        ["dailyCostUsd", dailyCostUsd],
        ["maxRevisions", maxRevisions],
        ["maxFails", maxFails],
        ["maxSignalsPerTask", maxSignalsPerTask],
        ["maxQaDepth", maxQaDepth],
        ["maxConcurrentSessions", maxConcurrentSessions],
        ["taskHourlyCostUsd", taskHourlyCostUsd],
      ];
      for (const [k, v] of fields) {
        const n = pickNumber(v);
        if (n !== undefined) limits[k] = n;
      }
      await api.updateProject(project.id, { settings: { limits } } as never);
      setStatus("Saved");
      onSaved();
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-16 py-12 flex flex-col gap-8 max-w-[700px]">
      <header className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">Safety Limits</h2>
          <p className="text-sm text-text-secondary">
            Per-project caps on cost and loop depth. Empty fields use the in-code default.
            Tasks tripping a cap get <code className="font-mono">frozen_reason</code> and an escalation —
            unfreeze from the task panel.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 pt-1">
          {status && <span className="text-xs text-text-tertiary">{status}</span>}
          <Button variant="primary-red" size="lg" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-5">
        <p className="text-xs font-mono uppercase tracking-wider text-text-tertiary border-b border-border pb-2">
          Cost
        </p>
        <Field label="Daily cost cap (USD)" hint="0 = unlimited. Default: 20.">
          <input className={INPUT} value={dailyCostUsd} onChange={(e) => setDailyCostUsd(e.target.value)} placeholder="20" />
        </Field>
        <Field label="Per-task hourly cap (USD)" hint="Cost-velocity watcher freezes tasks above this. Default: 5.">
          <input className={INPUT} value={taskHourlyCostUsd} onChange={(e) => setTaskHourlyCostUsd(e.target.value)} placeholder="5" />
        </Field>
      </section>

      <section className="flex flex-col gap-5">
        <p className="text-xs font-mono uppercase tracking-wider text-text-tertiary border-b border-border pb-2">
          Loop guards
        </p>
        <Field label="Max revisions" hint="Default: 5. PR-changes-requested past this freezes the task.">
          <input className={INPUT} value={maxRevisions} onChange={(e) => setMaxRevisions(e.target.value)} placeholder="5" />
        </Field>
        <Field label="Max QA fails" hint="Default: 3. tests_failed past this freezes the task.">
          <input className={INPUT} value={maxFails} onChange={(e) => setMaxFails(e.target.value)} placeholder="3" />
        </Field>
        <Field label="Max Q&A depth" hint="Default: 5. Caps agent ↔ TL question chains.">
          <input className={INPUT} value={maxQaDepth} onChange={(e) => setMaxQaDepth(e.target.value)} placeholder="5" />
        </Field>
        <Field label="Max signals per task" hint="Default: 200. Hard cap before silent reject.">
          <input className={INPUT} value={maxSignalsPerTask} onChange={(e) => setMaxSignalsPerTask(e.target.value)} placeholder="200" />
        </Field>
        <Field label="Max concurrent sessions" hint="Default: 4 (six roles total — leaves headroom).">
          <input className={INPUT} value={maxConcurrentSessions} onChange={(e) => setMaxConcurrentSessions(e.target.value)} placeholder="4" />
        </Field>
      </section>
    </div>
  );
}

function SystemTab() {
  const [config, setConfig] = useState<SystemConfig>({});
  const [claudeAuth, setClaudeAuth] = useState<"max" | "api">("max");
  const [apiKey, setApiKey] = useState("");
  const [orgDailyCap, setOrgDailyCap] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await api.fetchSystemConfig();
      setConfig(c);
      setClaudeAuth(c.claude_auth ?? "max");
      setApiKey(c.claude_api_key ?? "");
      setOrgDailyCap(c.orchestra_daily_cost_cap_usd ?? "");
    } catch {
      // system_config table may not exist yet (migration pending)
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const patch: SystemConfig = { claude_auth: claudeAuth };
      if (claudeAuth === "api") patch.claude_api_key = apiKey;
      if (orgDailyCap.trim()) patch.orchestra_daily_cost_cap_usd = orgDailyCap.trim();
      await api.updateSystemConfig(patch);
      setStatus("Saved — takes effect on the next agent run");
      setConfig({ ...config, ...patch });
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-16 py-12 flex flex-col gap-8 max-w-[700px]">
      <header className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">
            System Settings
          </h2>
          <p className="text-sm text-text-secondary">
            Global configuration applied to all agent runs. Changes take effect on the next run.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 pt-1">
          {status && <span className="text-xs text-text-tertiary">{status}</span>}
          <Button variant="primary-red" size="lg" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-5">
        <p className="text-xs font-mono uppercase tracking-wider text-text-tertiary border-b border-border pb-2">
          Claude Authentication
        </p>

        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name="claudeAuth"
              value="max"
              checked={claudeAuth === "max"}
              onChange={() => setClaudeAuth("max")}
              className="accent-accent-blue"
            />
            <div>
              <span className="text-sm font-medium text-text-primary">Max subscription</span>
              <p className="text-xs text-text-secondary">Uses your local Claude Code login — no API key needed.</p>
            </div>
          </label>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name="claudeAuth"
              value="api"
              checked={claudeAuth === "api"}
              onChange={() => setClaudeAuth("api")}
              className="accent-accent-blue"
            />
            <div>
              <span className="text-sm font-medium text-text-primary">API key</span>
              <p className="text-xs text-text-secondary">Uses ANTHROPIC_API_KEY — billed per token.</p>
            </div>
          </label>
        </div>

        {claudeAuth === "api" && (
          <Field label="API key" hint="Stored in the database, not in your .env file">
            <input
              className={INPUT}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-…"
              autoComplete="off"
            />
          </Field>
        )}
      </section>

      <section className="flex flex-col gap-5">
        <p className="text-xs font-mono uppercase tracking-wider text-text-tertiary border-b border-border pb-2">
          Orchestra-wide cost cap
        </p>
        <Field
          label="Daily cap (USD)"
          hint="Sum across every project. Empty / 0 = disabled. ORCHESTRA_DAILY_COST_CAP_USD env var overrides this if set."
        >
          <input
            className={INPUT}
            value={orgDailyCap}
            onChange={(e) => setOrgDailyCap(e.target.value)}
            placeholder="0"
          />
        </Field>
      </section>
    </div>
  );
}

function Field({ label, hint, optional, children }: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-text-primary">{label}</span>
        {optional && <span className="text-[10px] text-text-tertiary uppercase tracking-wider">optional</span>}
      </div>
      {children}
      {hint && <p className="text-[11px] text-text-tertiary">{hint}</p>}
    </div>
  );
}

const INPUT = "h-8 px-3 bg-bg-input border border-border text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue w-full";
