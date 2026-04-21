import { useState, useEffect, useCallback } from "react";
import * as api from "../api";
import { AGENT_ROLES, type AgentCheck, type AgentRole, type Project } from "../types";
import { Button } from "./ui/Button";

type ChecksMap = Partial<Record<AgentRole, AgentCheck[]>>;

export function ProjectChecks({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [checks, setChecks] = useState<ChecksMap>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const projects = await api.fetchProjects();
    const p = projects.find((x) => x.id === projectId);
    if (!p) return;
    setProject(p);
    const s = (p.settings as { checks?: ChecksMap }) ?? {};
    setChecks(s.checks ?? {});
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  function updateCheck(role: AgentRole, i: number, patch: Partial<AgentCheck>) {
    setChecks((prev) => {
      const list = [...(prev[role] ?? [])];
      list[i] = { ...list[i], ...patch };
      return { ...prev, [role]: list };
    });
  }

  function addCheck(role: AgentRole) {
    setChecks((prev) => ({
      ...prev,
      [role]: [
        ...(prev[role] ?? []),
        { name: "", pattern: "**/*.ts", command: "", onFail: "warn" },
      ],
    }));
  }

  function removeCheck(role: AgentRole, i: number) {
    setChecks((prev) => {
      const list = [...(prev[role] ?? [])];
      list.splice(i, 1);
      const next = { ...prev, [role]: list };
      if (list.length === 0) delete next[role];
      return next;
    });
  }

  function resetRole(role: AgentRole) {
    setChecks((prev) => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
  }

  async function save() {
    if (!project) return;
    setSaving(true);
    setStatus(null);
    try {
      const clean: ChecksMap = {};
      for (const role of AGENT_ROLES) {
        const list = checks[role];
        if (!list?.length) continue;
        const kept = list.filter((c) => c.name && c.command);
        if (kept.length) clean[role] = kept;
      }
      const nextSettings = { ...(project.settings ?? {}), checks: clean };
      await api.updateProject(project.id, { settings: nextSettings } as Partial<Project>);
      setStatus("Saved");
      await load();
    } catch (e) {
      setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!project) return <div className="loading p-6 text-text-secondary">Loading…</div>;

  return (
    <div className="project-checks flex flex-col gap-8 px-16 py-12">
      <header className="checks-header flex items-start justify-between gap-8">
        <div className="flex flex-col gap-2 max-w-[700px]">
          <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">
            Project Checks — {project.name}
          </h2>
          <p className="checks-help text-sm text-text-secondary leading-relaxed">
            Override the role&apos;s default observe checks for this project. Empty rows are
            discarded on save. When a role is absent from this list, its built-in defaults apply.
          </p>
        </div>
        <div className="checks-actions flex items-center gap-3 shrink-0">
          {status && <span className="checks-status text-xs text-text-tertiary">{status}</span>}
          <Button variant="primary-red" size="lg" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-4">
        {AGENT_ROLES.map((role) => {
          const list = checks[role] ?? [];
          const overridden = role in checks;
          return (
            <section
              key={role}
              className="checks-role bg-bg-surface border border-border px-6 py-5 flex flex-col gap-3"
            >
              <div className="checks-role-header flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary capitalize">
                  {role}
                  {overridden && (
                    <span className="checks-badge font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 bg-accent-blue text-white">
                      override
                    </span>
                  )}
                </h3>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => addCheck(role)}>
                    + Add check
                  </Button>
                  {overridden && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ghost"
                      onClick={() => resetRole(role)}
                      title="Revert to role default"
                    >
                      Reset
                    </Button>
                  )}
                </div>
              </div>

              {list.length === 0 && (
                <div className="empty text-xs text-text-tertiary italic">
                  Using role default.
                </div>
              )}

              {list.length > 0 && (
                <table className="checks-table w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-left font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
                      <th className="pb-2 pr-3 border-b border-border font-medium">Name</th>
                      <th className="pb-2 pr-3 border-b border-border font-medium">Pattern</th>
                      <th className="pb-2 pr-3 border-b border-border font-medium">Command</th>
                      <th className="pb-2 pr-3 border-b border-border font-medium w-[120px]">On Fail</th>
                      <th className="pb-2 border-b border-border w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c, i) => (
                      <tr key={i} className="align-top">
                        <td className="py-1.5 pr-3">
                          <input
                            className={FIELD}
                            value={c.name}
                            onChange={(e) => updateCheck(role, i, { name: e.target.value })}
                            placeholder="e.g. tsc"
                          />
                        </td>
                        <td className="py-1.5 pr-3">
                          <input
                            className={FIELD}
                            value={c.pattern}
                            onChange={(e) => updateCheck(role, i, { pattern: e.target.value })}
                            placeholder="glob"
                          />
                        </td>
                        <td className="py-1.5 pr-3">
                          <input
                            className={FIELD}
                            value={c.command}
                            onChange={(e) => updateCheck(role, i, { command: e.target.value })}
                            placeholder="pnpm exec tsc --noEmit"
                          />
                        </td>
                        <td className="py-1.5 pr-3">
                          <select
                            className={FIELD}
                            value={c.onFail}
                            onChange={(e) => updateCheck(role, i, { onFail: e.target.value as "warn" | "alert" })}
                          >
                            <option value="warn">warn</option>
                            <option value="alert">alert</option>
                          </select>
                        </td>
                        <td className="py-1.5 text-right">
                          <button
                            type="button"
                            className="ghost danger h-7 w-7 grid place-items-center text-text-tertiary hover:text-accent-red border border-border hover:border-accent-red transition-colors"
                            onClick={() => removeCheck(role, i)}
                            aria-label={`Remove ${role} check ${i + 1}`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

const FIELD =
  "w-full h-8 px-2.5 bg-bg-input border border-border text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue font-mono";
