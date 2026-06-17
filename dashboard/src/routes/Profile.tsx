import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "../contexts/ProjectContext";
import { useAuth } from "../contexts/AuthContext";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import * as api from "../api";

export default function Profile() {
  const { projects } = useProjectContext();
  const { user } = useAuth();

  if (!user) return null; // RequireAuth has redirected — render nothing while it does

  const joined = user.createdAt.toLocaleDateString(undefined, { month: "short", year: "numeric" });

  return (
    <div className="profile flex gap-12 px-16 py-12">
      <ProfileSidebar />
      <div className="w-px bg-border shrink-0" />
      <main className="flex-1 flex flex-col gap-8 min-w-0">
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-text-primary">Сведения о профиле</h2>
          <Card className="p-6 flex flex-col gap-4">
            <DetailRow label="Имя пользователя" value={user.username} mono />
            <DetailRow label="Email"    value={user.email} />
            <DetailRow label="Дата регистрации"   value={joined} mono />
          </Card>
        </section>

        {user.isAdmin && <GitIntegrationSection />}

        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-text-primary">Мои проекты</h2>
            <span className="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
              всего {projects?.length ?? 0}
            </span>
          </div>
          <ul className="flex flex-col gap-3">
            {projects?.map((p) => (
              <li key={p.id}>
                <Card className="flex items-center gap-4 px-5 py-4">
                  <div className="h-10 w-10 bg-bg-input border border-border grid place-items-center text-text-secondary font-semibold">
                    {p.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-text-primary truncate">{p.name}</span>
                    <span className="font-mono text-[11px] text-text-tertiary truncate">
                      #{p.id.slice(0, 8)}
                      {p.repoUrl ? ` · ${p.repoUrl}` : ""}
                    </span>
                  </div>
                </Card>
              </li>
            ))}
            {(!projects || projects.length === 0) && (
              <li className="text-text-tertiary italic text-sm">Пока нет проектов.</li>
            )}
          </ul>
        </section>
      </main>
    </div>
  );
}

function ProfileSidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  const initial = (user.username || user.email).slice(0, 1).toUpperCase();

  async function handleSignOut() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <aside className="w-[300px] shrink-0 flex flex-col items-center gap-8">
      <div className="h-[120px] w-[120px] rounded-full bg-accent-blue grid place-items-center text-white font-semibold text-5xl">
        {initial}
      </div>
      <div className="text-center flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{user.username}</h1>
        <p className="font-mono text-xs text-text-tertiary">{user.email}</p>
      </div>

      <nav className="w-full flex flex-col">
        <SidebarAction label="Настройки аккаунта" divider />
        <SidebarAction label="Уведомления" divider />
        <SidebarAction label="Выйти" danger onClick={handleSignOut} />
      </nav>
    </aside>
  );
}

function SidebarAction({
  label, divider, danger, onClick,
}: {
  label: string;
  divider?: boolean;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex items-center px-4 py-3.5 text-sm transition-colors text-left",
        divider ? "border-b border-border" : "",
        danger ? "text-accent-red hover:text-accent-red" : "text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

/**
 * Instance-admin only: per-deployment GitHub App / GitLab OAuth setup. Each
 * client deployment registers its OWN apps here so the per-user "Connect"
 * buttons in Project Settings light up. GitHub uses the manifest flow (~2
 * clicks); GitLab needs a one-time client id/secret paste.
 */
function GitIntegrationSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["git-integration"], queryFn: api.fetchGitIntegration });

  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setup = params.get("git_setup");
    if (!setup) return;
    const detail = params.get("detail");
    setBanner(
      setup === "github_ok"
        ? { ok: true, text: `GitHub App создан${detail ? `: ${detail}` : ""}.` }
        : { ok: false, text: `Ошибка настройки${detail ? `: ${detail}` : "."}` },
    );
    params.delete("git_setup");
    params.delete("detail");
    const qs = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    queryClient.invalidateQueries({ queryKey: ["git-integration"] });
  }, []);

  const [org, setOrg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // GitLab form state
  const [glClientId, setGlClientId] = useState("");
  const [glClientSecret, setGlClientSecret] = useState("");
  const [glBaseUrl, setGlBaseUrl] = useState("https://gitlab.com");
  const [glStatus, setGlStatus] = useState<string | null>(null);

  const noPublicUrl = data && !data.publicUrl;

  async function setupGitHub() {
    setBusy(true);
    setErr(null);
    try {
      const { postUrl, manifest } = await api.startGitHubManifest(org.trim() || undefined);
      // Auto-submit a form to GitHub — top-level navigation; GitHub walks the
      // admin through app creation and redirects back to manifest-callback.
      const form = document.createElement("form");
      form.method = "POST";
      form.action = postUrl;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = manifest;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function disconnect(provider: "github" | "gitlab") {
    setBusy(true);
    try {
      await api.clearGitIntegration(provider);
      await queryClient.invalidateQueries({ queryKey: ["git-integration"] });
    } finally {
      setBusy(false);
    }
  }

  async function saveGitLab() {
    setBusy(true);
    setGlStatus(null);
    try {
      await api.saveGitLabIntegration({
        clientId: glClientId.trim(),
        clientSecret: glClientSecret.trim(),
        baseUrl: glBaseUrl.trim() || undefined,
      });
      setGlClientId("");
      setGlClientSecret("");
      setGlStatus("Сохранено.");
      await queryClient.invalidateQueries({ queryKey: ["git-integration"] });
    } catch (e) {
      setGlStatus(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "h-8 px-3 bg-bg-input border border-border text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue w-full";

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-text-primary">Интеграция Git (администратор)</h2>
        <p className="text-xs text-text-secondary">
          Подключите GitHub App / GitLab OAuth для этого сервера один раз. После этого
          пользователи смогут подключать репозитории в один клик в настройках проекта.
        </p>
      </div>

      {banner && (
        <p className={`text-xs ${banner.ok ? "text-accent-green" : "text-accent-red"}`}>{banner.text}</p>
      )}
      {noPublicUrl && (
        <p className="text-xs text-accent-red">
          Не задан <code>ORCHESTRA_PUBLIC_URL</code>. OAuth-редиректы используют{" "}
          <code>{data?.effectiveBaseUrl}</code> — за прокси укажите публичный URL в окружении.
        </p>
      )}

      {isLoading && <p className="text-xs text-text-tertiary">Загрузка…</p>}

      {data && (
        <Card className="p-6 flex flex-col gap-6">
          {/* GitHub */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">GitHub App</span>
              {data.github.configured
                ? <span className="text-[11px] text-accent-green">✓ {data.github.appSlug ?? "настроен"} ({data.github.source})</span>
                : <span className="text-[11px] text-text-tertiary">не настроен</span>}
            </div>
            <p className="text-[11px] text-text-tertiary">
              Создаётся через манифест GitHub за пару кликов — id, секрет и приватный ключ
              сохранятся автоматически. Callback: <code>{data.callbackUrls.github}</code>
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                className={`${inputCls} max-w-[220px]`}
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                placeholder="организация (необязательно)"
              />
              <Button variant="primary-red" size="sm" type="button" disabled={busy} onClick={setupGitHub}>
                {data.github.configured ? "Пересоздать GitHub App" : "Создать GitHub App"}
              </Button>
              {data.github.configured && data.github.source === "db" && (
                <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={() => disconnect("github")}>
                  Отключить
                </Button>
              )}
            </div>
          </div>

          <div className="h-px bg-border" />

          {/* GitLab */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">GitLab OAuth</span>
              {data.gitlab.configured
                ? <span className="text-[11px] text-accent-green">✓ {data.gitlab.baseUrl} ({data.gitlab.source})</span>
                : <span className="text-[11px] text-text-tertiary">не настроен</span>}
            </div>
            <p className="text-[11px] text-text-tertiary">
              В GitLab создайте OAuth-приложение (scope <code>api</code>, confidential) с
              redirect <code>{data.callbackUrls.gitlab}</code> и вставьте client id/secret.
            </p>
            <div className="flex flex-col gap-2 max-w-[460px]">
              <input className={inputCls} value={glClientId} onChange={(e) => setGlClientId(e.target.value)} placeholder="Application ID" autoComplete="off" />
              <input className={inputCls} type="password" value={glClientSecret} onChange={(e) => setGlClientSecret(e.target.value)} placeholder="Secret" autoComplete="off" />
              <input className={inputCls} value={glBaseUrl} onChange={(e) => setGlBaseUrl(e.target.value)} placeholder="https://gitlab.com" />
              <div className="flex items-center gap-2">
                <Button variant="primary-red" size="sm" type="button" disabled={busy || !glClientId.trim() || !glClientSecret.trim()} onClick={saveGitLab}>
                  Сохранить
                </Button>
                {data.gitlab.configured && data.gitlab.source === "db" && (
                  <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={() => disconnect("gitlab")}>
                    Отключить
                  </Button>
                )}
                {glStatus && <span className="text-[11px] text-text-tertiary">{glStatus}</span>}
              </div>
            </div>
          </div>

          {err && <p className="text-xs text-accent-red">Ошибка: {err}</p>}
        </Card>
      )}
    </section>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center">
      <span className="w-28 shrink-0 text-xs font-medium text-text-secondary uppercase tracking-wider">
        {label}
      </span>
      <span className={`text-sm text-text-primary ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
