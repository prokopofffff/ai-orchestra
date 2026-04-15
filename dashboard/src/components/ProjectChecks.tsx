import { useState, useEffect, useCallback } from "react";
import * as api from "../api";
import { AGENT_ROLES, type AgentCheck, type AgentRole, type Project } from "../types";

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
      // Strip empty rows, validate names
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

  if (!project) return <div className="loading">Loading…</div>;

  return (
    <div className="project-checks">
      <div className="checks-header">
        <h2>Project Checks — {project.name}</h2>
        <div className="checks-actions">
          {status && <span className="checks-status">{status}</span>}
          <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
      <p className="checks-help">
        Override the role's default observe checks for this project. Empty rows are discarded on save.
        When a role is absent from this list, its built-in defaults apply.
      </p>

      {AGENT_ROLES.map((role) => {
        const list = checks[role] ?? [];
        const overridden = role in checks;
        return (
          <section key={role} className="checks-role">
            <div className="checks-role-header">
              <h3>
                {role}
                {overridden && <span className="checks-badge">override</span>}
              </h3>
              <div>
                <button onClick={() => addCheck(role)}>+ Add check</button>
                {overridden && (
                  <button className="ghost" onClick={() => resetRole(role)} title="Revert to role default">
                    Reset
                  </button>
                )}
              </div>
            </div>

            {list.length === 0 && (
              <div className="empty">Using role default.</div>
            )}

            {list.length > 0 && (
              <table className="checks-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Pattern</th>
                    <th>Command</th>
                    <th>On Fail</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          value={c.name}
                          onChange={(e) => updateCheck(role, i, { name: e.target.value })}
                          placeholder="e.g. tsc"
                        />
                      </td>
                      <td>
                        <input
                          value={c.pattern}
                          onChange={(e) => updateCheck(role, i, { pattern: e.target.value })}
                          placeholder="glob"
                        />
                      </td>
                      <td>
                        <input
                          value={c.command}
                          onChange={(e) => updateCheck(role, i, { command: e.target.value })}
                          placeholder="pnpm exec tsc --noEmit"
                        />
                      </td>
                      <td>
                        <select
                          value={c.onFail}
                          onChange={(e) => updateCheck(role, i, { onFail: e.target.value as "warn" | "alert" })}
                        >
                          <option value="warn">warn</option>
                          <option value="alert">alert</option>
                        </select>
                      </td>
                      <td>
                        <button className="ghost danger" onClick={() => removeCheck(role, i)}>×</button>
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
  );
}
