import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "../contexts/ProjectContext";
import { ProjectChecks } from "../components/ProjectChecks";
import { EmptyProjects } from "../components/EmptyProjects";
import { Button } from "../components/ui/Button";
import * as api from "../api";
import type { SystemConfig } from "../api";
import type { Project } from "../types";

type Tab = "project" | "checks" | "system";

export default function Settings() {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("project");

  if (!project) return <EmptyProjects />;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["projects"] });

  return (
    <div className="settings flex flex-col h-full">
      <nav className="settings-tabs flex items-center gap-0 px-16 border-b border-border bg-bg-surface shrink-0">
        {(["project", "checks", "system"] as Tab[]).map((t) => (
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
            {t === "project" ? "Project" : t === "checks" ? "Agent Checks" : "System"}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        {tab === "project" && <ProjectTab project={project} onSaved={refresh} />}
        {tab === "checks" && <ProjectChecks projectId={project.id} />}
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
            <input
              className={INPUT}
              value={localPath}
              onChange={(e) => setLocalPath(e.target.value)}
              placeholder="/Users/you/projects/myapp"
            />
          </Field>

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

function SystemTab() {
  const [config, setConfig] = useState<SystemConfig>({});
  const [claudeAuth, setClaudeAuth] = useState<"max" | "api">("max");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await api.fetchSystemConfig();
      setConfig(c);
      setClaudeAuth(c.claude_auth ?? "max");
      setApiKey(c.claude_api_key ?? "");
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
