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
            {t === "project" ? "Проект"
              : t === "agents" ? "Агенты"
              : t === "checks" ? "Проверки агентов"
              : t === "members" ? "Участники"
              : t === "limits" ? "Лимиты"
              : "Система"}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        {tab === "project" && (
          <div className="flex flex-col">
            <ProjectTab project={project} onSaved={refresh} />
            <ProjectIntroSection project={project} />
            <ProjectClaudeSection project={project} onSaved={refresh} />
            <ProjectGitTokenSection project={project} onSaved={refresh} />
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
      setStatus("Сохранено");
      onSaved();
    } catch (e) {
      setStatus(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-16 py-12 flex flex-col gap-8 max-w-[700px]">
      <header className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">
            Настройки проекта
          </h2>
          <p className="text-sm text-text-secondary">
            Укажите репозиторий или локальный каталог, в котором будут работать агенты.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 pt-1">
          {status && <span className="text-xs text-text-tertiary">{status}</span>}
          <Button variant="primary-red" size="lg" onClick={save} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </header>

      {!hasRepo && (
        <div className="flex items-start gap-3 px-4 py-3 bg-[color:var(--color-accent-red,#e74c3c)]/10 border border-[color:var(--color-accent-red,#e74c3c)]/30 text-xs text-text-secondary">
          <span className="shrink-0 font-semibold text-accent-red mt-0.5">!</span>
          Агенты не смогут запуститься, пока ниже не указан URL репозитория или локальный путь.
        </div>
      )}

      <RepoStatusBanner projectId={project.id} />

      <section className="flex flex-col gap-5">
        <Field label="Название проекта">
          <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" />
        </Field>

        <Field label="Описание" optional>
          <input className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Краткое описание" />
        </Field>

        <div className="border-t border-border pt-5 flex flex-col gap-5">
          <p className="text-xs text-text-secondary">
            Укажите либо URL удалённого репозитория, <em>либо</em> путь к локальному каталогу. Локальный путь
            предпочтительнее — агенты создают git worktree-ы напрямую из него без клонирования.
          </p>

          <Field label="Локальный каталог" hint="Абсолютный путь к git-репозиторию на этой машине (например, /Users/you/myapp)">
            <div className="flex items-center gap-2">
              <input
                className={INPUT}
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/Users/you/projects/myapp"
              />
              <Button variant="secondary" size="md" type="button" onClick={() => setPickerOpen(true)}>
                Обзор…
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

          <Field label="URL удалённого репозитория" hint="Используется, если не задан локальный путь — агенты клонируют репозиторий и работают в worktree-ах">
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

function RepoStatusBanner({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["repo-status", projectId],
    queryFn: () => api.fetchRepoStatus(projectId),
    refetchInterval: 10_000,
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!data?.needsInit) return null;

  async function init() {
    setBusy(true); setMsg(null);
    try {
      await api.initProjectGit(projectId);
      setMsg(`✓ Инициализирован в ${data?.localPath}. Агенты могут запускаться.`);
      await queryClient.invalidateQueries({ queryKey: ["repo-status", projectId] });
    } catch (e) {
      setMsg(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-[color:var(--color-accent-yellow,#f59e0b)]/10 border border-[color:var(--color-accent-yellow,#f59e0b)]/30 text-xs text-text-secondary">
      <span className="shrink-0 font-semibold text-accent-yellow mt-0.5">!</span>
      <div className="flex-1 flex flex-col gap-2">
        <div>
          <code className="text-text-primary">{data.localPath}</code> не является
          git-репозиторием. Агенты создают ветки через <code>git worktree</code>, поэтому
          путь нужно сначала инициализировать.
        </div>
        {msg && <span className="text-[11px] text-text-tertiary">{msg}</span>}
      </div>
      <Button variant="primary-blue" size="sm" onClick={init} disabled={busy} type="button">
        {busy ? "Инициализация…" : "Инициализировать git здесь"}
      </Button>
    </div>
  );
}

function ProjectClaudeSection({ project, onSaved }: { project: Project; onSaved: () => void }) {
  // Per-project Claude credentials. Empty → fall back to orchestra-wide
  // System tab values → fall back to .env. Auth = "max" (subscription via
  // local `claude` CLI) needs no API key; "api" requires one.
  type ClaudeSettings = { auth?: "max" | "api"; apiKey?: string };
  const initial = (project.settings as { claude?: ClaudeSettings } | undefined)?.claude;
  const [auth, setAuth] = useState<"" | "max" | "api">(initial?.auth ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setAuth(initial?.auth ?? "");
    setApiKey(initial?.apiKey ?? "");
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      // Build a settings.claude object that only includes set fields. An
      // empty value here means "delete the per-project override and fall
      // back to orchestra-wide" — PATCH sends undefined for the key.
      const claude: ClaudeSettings = {};
      if (auth) claude.auth = auth;
      if (apiKey.trim()) claude.apiKey = apiKey.trim();
      const payload = Object.keys(claude).length ? claude : { auth: undefined, apiKey: undefined };
      await api.updateProject(project.id, { settings: { claude: payload } } as never);
      setStatus(
        Object.keys(claude).length
          ? "Сохранено — агенты этого проекта при следующем запуске будут использовать эти учётные данные."
          : "Очищено — используются настройки уровня Orchestra из вкладки Система.",
      );
      onSaved();
    } catch (e) {
      setStatus(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="px-16 pb-12 -mt-2 max-w-[700px] flex flex-col gap-4">
      <div className="border-t border-border pt-6 flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-text-primary">Учётные данные Claude</h3>
        <p className="text-xs text-text-secondary">
          Необязательно. Переопределение авторизации Claude для проекта. Пустые значения наследуются из{" "}
          вкладки <strong>Система</strong>, затем из <code>.env</code>. Используйте это, если один проект
          должен работать на подписке Max, а другой — на API-ключе с оплатой по токенам.
        </p>
      </div>

      <Field label="Аутентификация" optional hint="Оставьте пустым, чтобы наследовать из вкладки Система.">
        <select
          value={auth}
          onChange={(e) => setAuth(e.target.value as "" | "max" | "api")}
          className={INPUT}
        >
          <option value="">(наследовать)</option>
          <option value="max">Подписка Max — использует локальный логин в CLI `claude`</option>
          <option value="api">API-ключ — оплата по токенам</option>
        </select>
      </Field>

      {auth === "api" && (
        <Field
          label="API-ключ"
          hint="С console.anthropic.com. Начинается с sk-ant-. Хранится в настройках проекта; виден только участникам проекта."
        >
          <div className="flex items-center gap-2">
            <input
              className={INPUT}
              type={revealed ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-…"
              autoComplete="off"
            />
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? "Скрыть" : "Показать"}
            </Button>
          </div>
        </Field>
      )}

      <div className="flex items-center gap-3">
        <Button variant="primary-red" size="md" onClick={save} disabled={saving} type="button">
          {saving ? "Сохранение…" : "Сохранить"}
        </Button>
        {status && <p className="text-xs text-text-tertiary">{status}</p>}
      </div>
    </section>
  );
}

function ProjectGitTokenSection({ project, onSaved }: { project: Project; onSaved: () => void }) {
  // Per-project Git provider token override. Empty → falls back to the
  // orchestra-wide GITHUB_TOKEN (System tab / .env). The provider type +
  // baseUrl (for self-hosted) are currently only editable as raw JSON;
  // 95% of users just need a token, so that's all we surface here.
  type ProviderSettings = { type?: "github" | "gitlab"; token?: string; baseUrl?: string };
  const initial = (project.settings as { provider?: ProviderSettings } | undefined)?.provider;
  const [token, setToken] = useState(initial?.token ?? "");
  const [type, setType] = useState<"" | "github" | "gitlab">(initial?.type ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setToken(initial?.token ?? "");
    setType(initial?.type ?? "");
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setSaving(true);
    setStatus(null);
    try {
      const provider: ProviderSettings = {};
      if (token.trim()) provider.token = token.trim();
      if (type) provider.type = type;
      // Preserve any existing baseUrl the user set via JSON elsewhere.
      if (initial?.baseUrl) provider.baseUrl = initial.baseUrl;
      const payload = Object.keys(provider).length
        ? provider
        : { type: undefined, token: undefined, baseUrl: undefined };
      await api.updateProject(project.id, { settings: { provider: payload } } as never);
      setStatus(
        token.trim()
          ? "Сохранено — клоны и пуши для этого проекта будут использовать этот токен."
          : "Очищено — используется общий GITHUB_TOKEN уровня Orchestra.",
      );
      onSaved();
    } catch (e) {
      setStatus(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="px-16 pb-12 -mt-2 max-w-[700px] flex flex-col gap-4">
      <div className="border-t border-border pt-6 flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-text-primary">Токен Git-провайдера</h3>
        <p className="text-xs text-text-secondary">
          Необязательно. Переопределение токена GitHub / GitLab для клонирования, пуша
          и открытия PR для этого проекта. Если пусто, используется значение из вкладки{" "}
          <strong>Система</strong>. Тип провайдера определяется автоматически по
          URL репозитория — указывайте его явно только для self-hosted инстансов.
        </p>
      </div>

      <Field label="Провайдер" optional hint="Определяется автоматически по URL репозитория, если поле пустое.">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "" | "github" | "gitlab")}
          className={INPUT}
        >
          <option value="">(автоопределение)</option>
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
        </select>
      </Field>

      <Field
        label="Токен доступа"
        hint="GitHub: fine-grained PAT с правами repo + pull-request на этот репозиторий. GitLab: project access token."
      >
        <div className="flex items-center gap-2">
          <input
            className={INPUT}
            type={revealed ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_… или glpat-…"
            autoComplete="off"
          />
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? "Скрыть" : "Показать"}
          </Button>
        </div>
      </Field>

      <div className="flex items-center gap-3">
        <Button variant="primary-red" size="md" onClick={save} disabled={saving} type="button">
          {saving ? "Сохранение…" : "Сохранить"}
        </Button>
        {status && <p className="text-xs text-text-tertiary">{status}</p>}
      </div>
    </section>
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
      setStatus(token.trim() ? "Сохранено — откройте бота в Telegram и отправьте /start, чтобы привязать чат." : "Telegram отключён для этого проекта.");
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Ошибка: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    if (!confirm("Отключить Telegram от этого проекта?")) return;
    setSaving(true);
    try {
      await api.updateProject(project.id, { settings: { telegram: { botToken: undefined, chatId: undefined } } } as never);
      setToken("");
      setSavedToken("");
      setSavedChatId("");
      setStatus("Отключено.");
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
            Необязательно. Для каждого проекта используется отдельный бот — создайте его через{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noopener" className="text-accent-blue hover:underline">@BotFather</a>{" "}
            в Telegram, вставьте токен ниже и отправьте <code>/start</code> боту. Один бот нельзя использовать в нескольких проектах.
          </p>
        </div>
        {savedToken && (
          <Button variant="secondary" size="sm" onClick={disconnect} disabled={saving} type="button">
            Отключить
          </Button>
        )}
      </div>

      <Field label="Токен бота" hint="Получен у @BotFather. Выглядит как 1234567890:AAH…">
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
            {saving ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </Field>

      {savedToken && (
        <div className="px-3 py-2 border border-border-subtle bg-bg-input text-xs flex items-center gap-2">
          {savedChatId ? (
            <>
              <span className="font-mono text-accent-green">✓</span>
              <span className="text-text-secondary">
                Подключено · чат <code className="text-text-primary">{savedChatId}</code> · уведомления агентов идут в Telegram.
              </span>
            </>
          ) : (
            <>
              <span className="font-mono text-accent-yellow">…</span>
              <span className="text-text-secondary">
                Токен сохранён. Отправьте <code className="text-text-primary">/start</code> боту в Telegram, чтобы привязать чат.
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
    if (!confirm("Запустить новое сканирование кодовой базы? Это создаст сессию Tech Lead.")) return;
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
          <h3 className="text-sm font-semibold text-text-primary">Обзор кодовой базы</h3>
          <p className="text-xs text-text-secondary">
            Первичное сканирование репозитория от Tech Lead — стек, структура,
            рекомендованные команды проверок, всё, на что стоит обратить внимание. Обновляется при
            повторном сканировании.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={rescan} disabled={rescanning} type="button">
          {rescanning ? "В очереди…" : intro ? "Пересканировать" : "Сканировать"}
        </Button>
      </div>

      {inProgress && (
        <div className="px-3 py-2 border border-border-subtle bg-bg-input text-xs text-text-secondary font-mono">
          Tech Lead изучает кодовую базу. Сводка появится здесь
          по завершении.
        </div>
      )}

      {intro && (
        <article className="bg-bg-surface border border-border p-4 text-[13px] leading-relaxed text-text-primary whitespace-pre-wrap font-mono">
          {intro.body}
        </article>
      )}

      {!intro && !inProgress && (
        <div className="text-xs text-text-tertiary">
          Сканирование ещё не запускалось. Нажмите <code>Сканировать</code>, чтобы Tech Lead
          осмотрел репозиторий.
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
      setStatus("Сохранено — применится при следующем запуске агента");
      onSaved();
    } catch (e) {
      setStatus(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-16 py-12 flex flex-col gap-8 max-w-[700px]">
      <header className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">Агенты</h2>
          <p className="text-sm text-text-secondary">
            Выберите модель и уровень усилий для каждой роли. Пусто = используется
            глобальное значение по умолчанию. Уровень `max` работает только на Opus. Чем выше уровень,
            тем медленнее, тщательнее и дороже.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 pt-1">
          {status && <span className="text-xs text-text-tertiary">{status}</span>}
          <Button variant="primary-red" size="lg" onClick={save} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-2">
        <div className="grid grid-cols-[120px_1fr_1fr] gap-3 px-3 pb-2 border-b border-border text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
          <span>Роль</span>
          <span>Модель</span>
          <span>Усилия</span>
        </div>
        {ROLES.map((role) => (
          <div key={role} className="grid grid-cols-[120px_1fr_1fr] gap-3 items-center px-3 py-2 border-b border-border-subtle">
            <span className="text-sm text-text-primary font-medium">{role}</span>
            <select
              className={INPUT}
              value={models[role]}
              onChange={(e) => setModels((m) => ({ ...m, [role]: e.target.value }))}
            >
              <option value="">(глобальное по умолчанию)</option>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <select
              className={INPUT}
              value={efforts[role]}
              onChange={(e) => setEfforts((m) => ({ ...m, [role]: e.target.value }))}
            >
              <option value="">(по умолчанию SDK)</option>
              {EFFORTS.map((eff) => (
                <option key={eff} value={eff} disabled={eff === "max" && models[role] !== "opus"}>
                  {eff}{eff === "max" ? " (только Opus)" : ""}
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
      setStatus("Участник добавлен");
      refresh();
    } catch (e) {
      setStatus(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    if (!confirm("Удалить этого участника из проекта?")) return;
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
        <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">Участники</h2>
        <p className="text-sm text-text-secondary">
          Пользователи с доступом к этому проекту. Владелец имеет полный контроль.
          Администраторы могут приглашать и удалять. Редакторы могут вносить изменения в проект.
          Зрители видят всё, но ничего не могут менять.
        </p>
      </header>

      <form onSubmit={invite} className="flex flex-col gap-3 border border-border bg-bg-surface p-4">
        <h3 className="text-xs font-mono uppercase tracking-wider text-text-tertiary">Пригласить по имени пользователя или email</h3>
        <div className="flex gap-2">
          <input
            className={INPUT}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="alice@example.com или alice"
          />
          <select
            className={`${INPUT} w-32`}
            value={role}
            onChange={(e) => setRole(e.target.value as "viewer" | "editor" | "admin")}
          >
            <option value="viewer">Зритель</option>
            <option value="editor">Редактор</option>
            <option value="admin">Администратор</option>
          </select>
          <Button variant="primary-blue" size="md" type="submit" disabled={busy}>
            {busy ? "…" : "Пригласить"}
          </Button>
        </div>
        {status && <span className="text-xs text-text-tertiary">{status}</span>}
      </form>

      <section className="flex flex-col gap-2">
        {isLoading && <p className="text-sm text-text-tertiary">Загрузка…</p>}
        {error && <p className="text-sm text-accent-red">Не удалось загрузить участников.</p>}
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
            <option value="viewer">Зритель</option>
            <option value="editor">Редактор</option>
            <option value="admin">Администратор</option>
          </select>
        )}
        {onRemove && (
          <Button variant="primary-red" size="sm" onClick={onRemove}>Удалить</Button>
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
      setStatus("Сохранено");
      onSaved();
    } catch (e) {
      setStatus(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-16 py-12 flex flex-col gap-8 max-w-[700px]">
      <header className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">Лимиты безопасности</h2>
          <p className="text-sm text-text-secondary">
            Ограничения по стоимости и глубине циклов для проекта. Пустые поля используют значения по умолчанию из кода.
            Задачи, превысившие лимит, получают <code className="font-mono">frozen_reason</code> и эскалацию —
            разморозить можно из панели задачи.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 pt-1">
          {status && <span className="text-xs text-text-tertiary">{status}</span>}
          <Button variant="primary-red" size="lg" onClick={save} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-5">
        <p className="text-xs font-mono uppercase tracking-wider text-text-tertiary border-b border-border pb-2">
          Стоимость
        </p>
        <Field label="Дневной лимит стоимости (USD)" hint="0 = без ограничений. По умолчанию: 20.">
          <input className={INPUT} value={dailyCostUsd} onChange={(e) => setDailyCostUsd(e.target.value)} placeholder="20" />
        </Field>
        <Field label="Часовой лимит на задачу (USD)" hint="Наблюдатель за скоростью затрат замораживает задачи выше этого порога. По умолчанию: 5.">
          <input className={INPUT} value={taskHourlyCostUsd} onChange={(e) => setTaskHourlyCostUsd(e.target.value)} placeholder="5" />
        </Field>
      </section>

      <section className="flex flex-col gap-5">
        <p className="text-xs font-mono uppercase tracking-wider text-text-tertiary border-b border-border pb-2">
          Защита от циклов
        </p>
        <Field label="Макс. число правок" hint="По умолчанию: 5. PR-changes-requested сверх этого замораживает задачу.">
          <input className={INPUT} value={maxRevisions} onChange={(e) => setMaxRevisions(e.target.value)} placeholder="5" />
        </Field>
        <Field label="Макс. число провалов QA" hint="По умолчанию: 3. tests_failed сверх этого замораживает задачу.">
          <input className={INPUT} value={maxFails} onChange={(e) => setMaxFails(e.target.value)} placeholder="3" />
        </Field>
        <Field label="Макс. глубина Q&A" hint="По умолчанию: 5. Ограничивает цепочки вопросов между агентом и TL.">
          <input className={INPUT} value={maxQaDepth} onChange={(e) => setMaxQaDepth(e.target.value)} placeholder="5" />
        </Field>
        <Field label="Макс. сигналов на задачу" hint="По умолчанию: 200. Жёсткий лимит перед молчаливым отклонением.">
          <input className={INPUT} value={maxSignalsPerTask} onChange={(e) => setMaxSignalsPerTask(e.target.value)} placeholder="200" />
        </Field>
        <Field label="Макс. число одновременных сессий" hint="По умолчанию: 4 (всего шесть ролей — оставляет запас).">
          <input className={INPUT} value={maxConcurrentSessions} onChange={(e) => setMaxConcurrentSessions(e.target.value)} placeholder="4" />
        </Field>
      </section>
    </div>
  );
}

function SystemTab() {
  const [config, setConfig] = useState<SystemConfig>({});
  const [claudeAuth, setClaudeAuth] = useState<"max" | "api">("max");
  const [orgDailyCap, setOrgDailyCap] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await api.fetchSystemConfig();
      setConfig(c);
      setClaudeAuth(c.claude_auth ?? "max");
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
      if (orgDailyCap.trim()) patch.orchestra_daily_cost_cap_usd = orgDailyCap.trim();
      await api.updateSystemConfig(patch);
      setStatus("Сохранено — применится при следующем запуске агента");
      setConfig({ ...config, ...patch });
    } catch (e) {
      setStatus(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="px-16 py-12 flex flex-col gap-8 max-w-[700px]">
      <header className="flex items-start justify-between gap-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[28px] font-semibold tracking-tight text-text-primary">
            Системные настройки
          </h2>
          <p className="text-sm text-text-secondary">
            Значения по умолчанию для всей Orchestra. Учётные данные (API-ключ Claude, токен GitHub / GitLab)
            хранятся в каждом проекте в <strong>Настройках проекта</strong> — эти значения
            не общие между проектами и пользователями.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 pt-1">
          {status && <span className="text-xs text-text-tertiary">{status}</span>}
          <Button variant="primary-red" size="lg" onClick={save} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить"}
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-5">
        <p className="text-xs font-mono uppercase tracking-wider text-text-tertiary border-b border-border pb-2">
          Режим Claude по умолчанию
        </p>

        <p className="text-xs text-text-secondary -mt-2">
          Используется, если проект не переопределяет его в Настройках проекта → Учётные данные Claude.
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
              <span className="text-sm font-medium text-text-primary">Подписка Max</span>
              <p className="text-xs text-text-secondary">Использует локальный логин Claude Code — API-ключ не требуется.</p>
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
              <span className="text-sm font-medium text-text-primary">API-ключ</span>
              <p className="text-xs text-text-secondary">
                Оплата по токенам. Каждый проект должен вставить свой ключ в Настройках проекта →
                Учётные данные Claude — общего ключа нет.
              </p>
            </div>
          </label>
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <p className="text-xs font-mono uppercase tracking-wider text-text-tertiary border-b border-border pb-2">
          Лимит стоимости для всей Orchestra
        </p>
        <Field
          label="Дневной лимит (USD)"
          hint="Сумма по всем проектам. Пусто / 0 = отключено. Переменная окружения ORCHESTRA_DAILY_COST_CAP_USD переопределяет это, если задана."
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
        {optional && <span className="text-[10px] text-text-tertiary uppercase tracking-wider">необязательно</span>}
      </div>
      {children}
      {hint && <p className="text-[11px] text-text-tertiary">{hint}</p>}
    </div>
  );
}

const INPUT = "h-8 px-3 bg-bg-input border border-border text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue w-full";
