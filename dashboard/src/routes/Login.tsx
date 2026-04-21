import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
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

export default function Login() {
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
        <p
          className="text-lg text-text-secondary max-w-[420px]"
          style={{ lineHeight: 1.6 }}
        >
          Orchestrate your AI development team.
          <br />
          Automate tasks, coordinate agents,
          <br />
          and ship faster.
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
  { icon: <BotIcon size={20} />,       label: "6 specialized AI agents working in parallel" },
  { icon: <GitBranchIcon size={20} />, label: "GitHub & GitLab integration out of the box" },
  { icon: <ZapIcon size={20} />,       label: "Event-driven task orchestration via n8n" },
];

function AgentViz() {
  // Absolute-positioned icon badges matching pen frame bpCZY (528w × 320h).
  // Coordinates are .pen-native; we render into a 528×320 box and let the panel
  // padding handle margins.
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
  {
    id: "code", x: 80,  y: 130, size: 56, bg: "var(--color-accent-blue)",
    glow: { blur: 14, spread: 2, color: "rgba(59,130,246,0.3)" },
    icon: <CodeIcon size={26} />,
  },
  {
    id: "palette", x: 220, y: 60, size: 48, bg: "var(--color-accent-purple)",
    glow: { blur: 14, spread: 2, color: "rgba(168,85,247,0.3)" },
    icon: <PaletteIcon size={22} />,
  },
  {
    id: "server", x: 350, y: 110, size: 48, bg: "var(--color-accent-green)",
    glow: { blur: 14, spread: 2, color: "rgba(34,197,94,0.3)" },
    icon: <ServerIcon size={22} />,
  },
  {
    id: "shield", x: 220, y: 200, size: 48, bg: "var(--color-accent-teal)",
    glow: { blur: 14, spread: 2, color: "rgba(20,184,166,0.3)" },
    icon: <ShieldCheckIcon size={22} />,
  },
  {
    id: "brain", x: 200, y: 120, size: 64,
    bg: "linear-gradient(135deg, #3B82F6 0%, #A855F7 100%)",
    glow: { blur: 20, spread: 4, color: "rgba(168,85,247,0.4)" },
    icon: <BrainIcon size={30} />,
  },
  {
    id: "terminal", x: 400, y: 220, size: 44, bg: "var(--color-accent-orange)",
    glow: { blur: 14, spread: 2, color: "rgba(249,115,22,0.3)" },
    icon: <TerminalIcon size={20} />,
  },
];

function FormPanel() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    navigate("/kanban");
  }

  return (
    <section className="flex flex-1 items-center justify-center p-12 lg:p-20">
      <form
        onSubmit={onSubmit}
        className="flex w-full max-w-[400px] flex-col gap-8"
      >
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">
            Welcome back
          </h1>
          <p className="text-sm text-text-secondary">
            Sign in to your workspace
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
              className="h-11 px-3.5 bg-bg-input border border-border text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue"
              placeholder="you@example.com"
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="h-11 px-3.5 bg-bg-input border border-border text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue"
              placeholder="••••••••"
            />
          </Field>
        </div>

        <button
          type="submit"
          className="inline-flex h-[46px] w-full items-center justify-center gap-2 bg-accent-blue text-white text-[15px] font-semibold hover:bg-accent-blue/90 transition-colors"
        >
          Sign In
          <ArrowRightIcon size={16} />
        </button>

        <div className="flex items-center gap-4">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-text-tertiary">or continue with</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className="flex gap-3">
          <OAuthButton icon={<GitHubIcon size={18} />} label="GitHub" />
          <OAuthButton icon={<GitLabIcon size={18} />} label="GitLab" />
        </div>

        <p className="text-xs text-text-tertiary text-center">
          Don&apos;t have an account? Contact your admin
        </p>
      </form>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function OAuthButton({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      className="inline-flex h-11 flex-1 items-center justify-center gap-2 bg-bg-surface border border-border text-sm text-text-secondary hover:text-text-primary hover:border-text-secondary transition-colors"
    >
      {icon}
      {label}
    </button>
  );
}
