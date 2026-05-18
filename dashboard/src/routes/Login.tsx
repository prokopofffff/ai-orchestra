import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import {
  ArrowRightIcon,
  BotIcon,
  BrainIcon,
  CodeIcon,
  GitBranchIcon,
  GitHubIcon,
  GitLabIcon,
  PaletteIcon,
  ServerIcon,
  ShieldCheckIcon,
  TerminalIcon,
  ZapIcon,
} from "../components/ui/Icon";

type Mode = "login" | "signup";

export default function Login() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname: string } } };

  // If we open /login while already authed, redirect to wherever we came from.
  useEffect(() => {
    if (!loading && user) {
      navigate(location.state?.from?.pathname ?? "/kanban", { replace: true });
    }
  }, [loading, user, navigate, location.state]);

  return (
    <div className="flex min-h-dvh bg-bg-page">
      <BrandingPanel />
      <FormPanel />
    </div>
  );
}

function BrandingPanel() {
  return (
    <aside
      className="hidden lg:flex w-[640px] flex-col justify-between shrink-0 p-16"
      style={{
        background:
          "linear-gradient(180deg, #111115 0%, #1A1A1F 50%, #0D0D10 100%)",
      }}
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 grid place-items-center bg-accent-blue text-white">
            <CodeIcon size={22} />
          </div>
          <span className="text-[22px] font-bold tracking-tight text-text-primary">
            AI Orchestra
          </span>
        </div>
        <p className="text-lg text-text-secondary max-w-[420px]" style={{ lineHeight: 1.6 }}>
          Управляйте своей AI-командой разработки.
          <br />
          Автоматизируйте задачи, координируйте агентов
          <br />
          и выпускайте релизы быстрее.
        </p>
      </div>

      <AgentViz />

      <ul className="flex flex-col gap-5">
        {FEATURES.map((f) => (
          <li key={f.label} className="flex items-center gap-3">
            <span className="text-accent-blue shrink-0">{f.icon}</span>
            <span className="text-sm text-text-secondary">{f.label}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

const FEATURES = [
  { icon: <BotIcon size={20} />,       label: "6 специализированных AI-агентов, работающих параллельно" },
  { icon: <GitBranchIcon size={20} />, label: "Интеграция с GitHub и GitLab из коробки" },
  { icon: <ZapIcon size={20} />,       label: "Событийная оркестрация задач через n8n" },
];

function AgentViz() {
  return (
    <div
      className="relative bg-bg-sidebar border border-border-subtle overflow-hidden"
      style={{ height: 320 }}
    >
      {AGENT_NODES.map((n) => (
        <div
          key={n.id}
          className="absolute grid place-items-center text-white"
          style={{
            left: n.x,
            top: n.y,
            width: n.size,
            height: n.size,
            background: n.bg,
            borderRadius: "50%",
            boxShadow: `0 0 ${n.glow.blur}px ${n.glow.spread}px ${n.glow.color}`,
          }}
        >
          {n.icon}
        </div>
      ))}
    </div>
  );
}

const AGENT_NODES = [
  { id: "code",     x: 80,  y: 130, size: 56, bg: "var(--color-accent-blue)",   glow: { blur: 14, spread: 2, color: "rgba(59,130,246,0.3)" }, icon: <CodeIcon size={26} /> },
  { id: "palette",  x: 220, y: 60,  size: 48, bg: "var(--color-accent-purple)", glow: { blur: 14, spread: 2, color: "rgba(168,85,247,0.3)" }, icon: <PaletteIcon size={22} /> },
  { id: "server",   x: 350, y: 110, size: 48, bg: "var(--color-accent-green)",  glow: { blur: 14, spread: 2, color: "rgba(34,197,94,0.3)"  }, icon: <ServerIcon size={22} /> },
  { id: "shield",   x: 220, y: 200, size: 48, bg: "var(--color-accent-teal)",   glow: { blur: 14, spread: 2, color: "rgba(20,184,166,0.3)" }, icon: <ShieldCheckIcon size={22} /> },
  { id: "brain",    x: 200, y: 120, size: 64, bg: "linear-gradient(135deg, #3B82F6 0%, #A855F7 100%)", glow: { blur: 20, spread: 4, color: "rgba(168,85,247,0.4)" }, icon: <BrainIcon size={30} /> },
  { id: "terminal", x: 400, y: 220, size: 44, bg: "var(--color-accent-orange)", glow: { blur: 14, spread: 2, color: "rgba(249,115,22,0.3)" }, icon: <TerminalIcon size={20} /> },
];

function FormPanel() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { login, signup } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname: string } } };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await signup(email, username, password);
      }
      navigate(location.state?.from?.pathname ?? "/kanban", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Что-то пошло не так");
    } finally {
      setSubmitting(false);
    }
  }

  const isSignup = mode === "signup";

  return (
    <section className="flex flex-1 items-center justify-center p-12 lg:p-20">
      <form onSubmit={onSubmit} className="flex w-full max-w-[400px] flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">
            {isSignup ? "Создайте своё рабочее пространство" : "С возвращением"}
          </h1>
          <p className="text-sm text-text-secondary">
            {isSignup ? "Зарегистрируйтесь, чтобы начать" : "Войдите в своё рабочее пространство"}
          </p>
        </header>

        <div className="flex flex-col gap-5">
          <Field label="Email">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className={INPUT_CLS}
              placeholder="you@example.com"
            />
          </Field>
          {isSignup && (
            <Field label="Имя пользователя">
              <input
                type="text"
                required
                minLength={3}
                maxLength={30}
                pattern="[a-zA-Z0-9_]+"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                className={INPUT_CLS}
                placeholder="alice"
              />
            </Field>
          )}
          <Field label="Пароль" hint={isSignup ? "Не менее 8 символов" : undefined}>
            <input
              type="password"
              required
              minLength={isSignup ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={isSignup ? "new-password" : "current-password"}
              className={INPUT_CLS}
              placeholder="••••••••"
            />
          </Field>
        </div>

        {error && (
          <p className="text-xs text-accent-red bg-accent-red/10 border border-accent-red/30 px-3 py-2">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-[46px] w-full items-center justify-center gap-2 bg-accent-blue text-white text-[15px] font-semibold hover:bg-accent-blue/90 transition-colors disabled:opacity-60"
        >
          {submitting ? (isSignup ? "Создание…" : "Вход…") : isSignup ? "Создать аккаунт" : "Войти"}
          {!submitting && <ArrowRightIcon size={16} />}
        </button>

        <div className="flex items-center gap-4">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-text-tertiary">или войдите через</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className="flex gap-3">
          <OAuthButton icon={<GitHubIcon size={18} />} label="GitHub" />
          <OAuthButton icon={<GitLabIcon size={18} />} label="GitLab" />
        </div>

        <p className="text-xs text-text-tertiary text-center">
          {isSignup ? "Уже есть аккаунт?" : "Нет аккаунта?"}{" "}
          <button
            type="button"
            onClick={() => { setMode(isSignup ? "login" : "signup"); setError(null); }}
            className="text-accent-blue hover:underline"
          >
            {isSignup ? "Войти" : "Зарегистрироваться"}
          </button>
        </p>
      </form>
    </section>
  );
}

const INPUT_CLS = "h-11 px-3.5 bg-bg-input border border-border text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-text-tertiary">{hint}</span>}
    </label>
  );
}

function OAuthButton({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      disabled
      title="OAuth ещё не подключён"
      className="inline-flex h-11 flex-1 items-center justify-center gap-2 bg-bg-surface border border-border text-sm text-text-tertiary cursor-not-allowed"
    >
      {icon}
      {label}
    </button>
  );
}
