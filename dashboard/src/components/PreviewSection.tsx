import { useEffect, useState } from "react";
import * as api from "../api";
import type { PreviewStatus } from "../api";

/**
 * Settings widget for the per-project preview contour.
 *
 * UX flow (see docs/PREVIEW_CONTOUR_DESIGN.md):
 *   1. User toggles "Enable preview environment"
 *   2. Sets Dockerfile path, branch, app port, env vars, idle timeout
 *   3. Hits Save → server persists, NO deploy yet
 *   4. Hits Deploy → server pulls/builds/runs, blocks 60s, returns status
 *   5. Status pill keeps reflecting reality (refreshes every 10s)
 *
 * Env-var values are write-only over the wire: the GET only returns
 * the key list (envVarKeys), so the UI shows "***" for existing keys
 * and only sends `envVars` on save when the user explicitly edits the
 * textarea via "Edit env vars".
 */

const INPUT =
  "h-8 px-3 bg-bg-input border border-border text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue w-full";

const BTN =
  "h-8 px-3 text-xs font-medium border border-border bg-bg-card hover:bg-bg-hover text-text-primary disabled:opacity-50 disabled:cursor-not-allowed";

const BTN_PRIMARY =
  "h-8 px-3 text-xs font-medium border border-accent-blue bg-accent-blue text-white hover:bg-accent-blue/90 disabled:opacity-50 disabled:cursor-not-allowed";

export function PreviewSection({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "save" | "deploy" | "stop" | "teardown">(null);
  const [err, setErr] = useState<string | null>(null);

  // Editable form state — initialized from status, dirty-tracked.
  const [enabled, setEnabled] = useState(false);
  const [dockerfilePath, setDockerfilePath] = useState("");
  const [branch, setBranch] = useState("main");
  const [appPort, setAppPort] = useState("8080");
  const [idleTimeout, setIdleTimeout] = useState("120");
  const [autoRedeploy, setAutoRedeploy] = useState(true);

  // Env-vars editor: textarea content, only sent on save when "dirty".
  const [envEditorOpen, setEnvEditorOpen] = useState(false);
  const [envText, setEnvText] = useState("");
  const [envDirty, setEnvDirty] = useState(false);

  // Logs flyout
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  async function reload() {
    try {
      const s = await api.fetchPreview(projectId);
      setStatus(s);
      setEnabled(s.enabled);
      setDockerfilePath(s.dockerfilePath ?? "");
      setBranch(s.branch);
      setAppPort(String(s.appPort));
      setIdleTimeout(String(s.idleTimeoutMinutes));
      setAutoRedeploy(s.autoRedeployOnPush);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // Cheap polling so the status pill reflects building→running etc.
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function onSave() {
    setBusy("save"); setErr(null);
    try {
      const input: api.PreviewConfigInput = {
        enabled,
        dockerfilePath: dockerfilePath.trim() || null,
        branch: branch.trim() || "main",
        appPort: parseInt(appPort, 10) || 8080,
        idleTimeoutMinutes: parseInt(idleTimeout, 10) || 120,
        autoRedeployOnPush: autoRedeploy,
      };
      if (envDirty) input.envVars = parseEnv(envText);
      await api.savePreview(projectId, input);
      setEnvDirty(false);
      setEnvEditorOpen(false);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onDeploy() {
    setBusy("deploy"); setErr(null);
    try {
      await api.deployPreview(projectId);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onStop() {
    setBusy("stop"); setErr(null);
    try {
      await api.stopPreview(projectId);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onTeardown() {
    if (!confirm("Удалить preview-контейнер, образ и сеть проекта? Конфиг сохранится.")) return;
    setBusy("teardown"); setErr(null);
    try {
      await api.teardownPreview(projectId);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onShowLogs() {
    setLogsOpen(true);
    try {
      const r = await api.fetchPreviewLogs(projectId, 500);
      setLogs(r.lines);
    } catch (e) {
      setLogs([`(не удалось получить логи: ${e instanceof Error ? e.message : String(e)})`]);
    }
  }

  if (loading) return <section className="text-xs text-text-tertiary">Загрузка preview…</section>;

  return (
    <section className="border-t border-border pt-6 mt-4 flex flex-col gap-4">
      <p className="text-xs font-mono uppercase tracking-wider text-text-tertiary border-b border-border pb-2">
        Preview environment
      </p>

      {status && <StatusBanner s={status} projectId={projectId} />}

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Включить preview-контур для проекта</span>
      </label>

      <Field label="Dockerfile" hint="Путь относительно корня репозитория, например backend/Dockerfile">
        <input
          className={INPUT}
          value={dockerfilePath}
          onChange={(e) => setDockerfilePath(e.target.value)}
          placeholder="Dockerfile"
          disabled={!enabled}
        />
      </Field>

      <Field label="Ветка" hint="Какую ветку деплоить. На push в эту ветку preview автоматически переразвернётся.">
        <input
          className={INPUT}
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="main"
          disabled={!enabled}
        />
      </Field>

      <Field label="Порт приложения" hint="Порт, на котором приложение слушает HTTP внутри контейнера.">
        <input
          className={INPUT}
          value={appPort}
          onChange={(e) => setAppPort(e.target.value)}
          placeholder="8080"
          disabled={!enabled}
        />
      </Field>

      <Field
        label="Переменные окружения"
        hint="Передаются в контейнер. Хранятся зашифрованными, значения никогда не возвращаются клиенту."
      >
        {!envEditorOpen ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">
              {status?.envVarKeys.length
                ? `Установлено: ${status.envVarKeys.join(", ")}`
                : "Не заданы"}
            </span>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setEnvEditorOpen(true);
                setEnvText("");
              }}
              disabled={!enabled}
            >
              Edit env vars
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <textarea
              className={`${INPUT} h-32 py-2 font-mono`}
              value={envText}
              onChange={(e) => { setEnvText(e.target.value); setEnvDirty(true); }}
              placeholder={"DATABASE_URL=postgres://...\nAPI_KEY=sk-..."}
            />
            <p className="text-[11px] text-text-tertiary">
              Формат: KEY=value на строку. Пустые значения и комментарии (#) игнорируются.
              При сохранении полностью заменит текущий набор переменных.
            </p>
          </div>
        )}
      </Field>

      <Field label="Idle shutdown (минут)" hint="Через сколько минут без запросов остановить контейнер приложения. DinD остаётся горячим.">
        <input
          className={INPUT}
          value={idleTimeout}
          onChange={(e) => setIdleTimeout(e.target.value)}
          placeholder="120"
          disabled={!enabled}
        />
      </Field>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={autoRedeploy}
          onChange={(e) => setAutoRedeploy(e.target.checked)}
          disabled={!enabled}
        />
        <span>Авто-redeploy при push в выбранную ветку</span>
      </label>

      {err && (
        <div className="text-xs text-[color:var(--color-accent-red,#e74c3c)] border border-[color:var(--color-accent-red,#e74c3c)]/30 bg-[color:var(--color-accent-red,#e74c3c)]/5 p-2">
          {err}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className={BTN_PRIMARY} onClick={onSave} disabled={busy !== null}>
          {busy === "save" ? "Сохраняем…" : "Сохранить"}
        </button>
        <button
          type="button"
          className={BTN}
          onClick={onDeploy}
          disabled={busy !== null || !enabled || !dockerfilePath.trim()}
        >
          {busy === "deploy" ? "Деплой…" : "Deploy"}
        </button>
        <button
          type="button"
          className={BTN}
          onClick={onStop}
          disabled={busy !== null || status?.state !== "running"}
        >
          Stop
        </button>
        <button type="button" className={BTN} onClick={onShowLogs} disabled={busy !== null}>
          Logs
        </button>
        <button
          type="button"
          className={BTN}
          onClick={onTeardown}
          disabled={busy !== null || status?.state === "stopped"}
        >
          {busy === "teardown" ? "Удаляем…" : "Teardown"}
        </button>
      </div>

      {logsOpen && (
        <div className="border border-border bg-bg-card p-3 mt-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono uppercase tracking-wider text-text-tertiary">
              Preview logs (последние {logs.length} строк)
            </span>
            <button type="button" className={BTN} onClick={() => setLogsOpen(false)}>Скрыть</button>
          </div>
          <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-96 text-text-secondary">
            {logs.length ? logs.join("\n") : "(пусто)"}
          </pre>
        </div>
      )}
    </section>
  );
}

function StatusBanner({ s, projectId }: { s: PreviewStatus; projectId: string }) {
  const dotClass: Record<PreviewStatus["state"], string> = {
    stopped: "bg-text-tertiary",
    building: "bg-[color:var(--color-accent-yellow,#f1c40f)]",
    running: "bg-[color:var(--color-accent-green,#27ae60)]",
    sleeping: "bg-text-tertiary",
    error: "bg-[color:var(--color-accent-red,#e74c3c)]",
  };
  return (
    <div className="flex items-center gap-3 text-xs text-text-secondary flex-wrap">
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block w-2 h-2 rounded-full ${dotClass[s.state]}`} />
        <span className="text-text-primary font-medium">{s.state}</span>
      </span>
      {s.currentCommit && <span className="font-mono">commit {s.currentCommit.slice(0, 7)}</span>}
      {s.lastDeployedAt && <span>· deployed {timeAgo(s.lastDeployedAt)}</span>}
      {s.errorMessage && <span className="text-[color:var(--color-accent-red,#e74c3c)]">· {s.errorMessage}</span>}
      {(s.state === "running" || s.state === "sleeping") && (
        <a
          href={`/preview/${projectId}/`}
          target="_blank"
          rel="noopener"
          className="ml-auto text-accent-blue hover:underline"
        >
          Open preview →
        </a>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-primary">{label}</span>
      {children}
      {hint && <p className="text-[11px] text-text-tertiary">{hint}</p>}
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Parse a KEY=VALUE-per-line block into a record. Ignores blank lines
 * and lines starting with #. Splits on the first = so values may
 * contain = themselves.
 */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1);
    if (k) out[k] = v;
  }
  return out;
}
