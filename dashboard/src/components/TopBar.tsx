import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useProjectContext } from "../contexts/ProjectContext";
import { useAuth } from "../contexts/AuthContext";
import { ChevronDownIcon } from "./ui/Icon";

const TABS = [
  { to: "/kanban",   label: "Kanban"   },
  { to: "/chat",     label: "Chat"     },
  { to: "/signals",  label: "Signals"  },
  { to: "/agents",   label: "Agents"   },
  { to: "/flow",     label: "Flow"     },
  { to: "/logs",     label: "Logs"     },
  { to: "/settings", label: "Settings" },
] as const;

export function TopBar() {
  const { projects, selectedProjectId, setSelectedProjectId, project } = useProjectContext();

  return (
    <header className="flex h-14 items-center gap-6 bg-bg-surface border-b border-border px-6 shrink-0">
      <span className="text-base font-bold tracking-tight text-text-primary whitespace-nowrap">
        AI Orchestra
      </span>

      <div className="h-6 w-px bg-border" />

      <ProjectSelector
        projects={projects}
        value={selectedProjectId}
        onChange={setSelectedProjectId}
        currentName={project?.name}
      />

      <nav className="flex h-full flex-1">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              [
                "inline-flex h-full items-center px-4 text-[13px] transition-colors",
                "border-b-2",
                isActive
                  ? "border-accent-red text-text-primary font-medium"
                  : "border-transparent text-text-secondary hover:text-text-primary",
              ].join(" ")
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <UserMenu />
    </header>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!user) return null;
  const initial = (user.username || user.email).slice(0, 1).toUpperCase();

  async function handleSignOut() {
    setOpen(false);
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="User menu"
        className="inline-flex items-center gap-2 px-2 py-1.5 hover:bg-bg-hover transition-colors"
      >
        <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-blue text-xs font-semibold text-white">
          {initial}
        </span>
        <span className="hidden sm:inline text-xs text-text-secondary font-medium">{user.username}</span>
        <ChevronDownIcon size={12} className="text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-bg-surface border border-border shadow-xl z-50">
          <button
            type="button"
            onClick={() => { setOpen(false); navigate("/profile"); }}
            className="block w-full text-left px-4 py-2.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            Profile
          </button>
          <div className="border-t border-border-subtle" />
          <button
            type="button"
            onClick={handleSignOut}
            className="block w-full text-left px-4 py-2.5 text-xs text-accent-red hover:bg-bg-hover transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectSelector({
  projects,
  value,
  onChange,
  currentName,
}: {
  projects: { id: string; name: string }[] | undefined;
  value: string | null;
  onChange: (id: string) => void;
  currentName: string | undefined;
}) {
  return (
    <label className="relative inline-flex items-center gap-2 px-3 py-1.5 border border-border cursor-pointer">
      <span className="font-mono text-xs text-text-secondary font-medium">
        {currentName ?? "No project"}
      </span>
      <ChevronDownIcon size={14} className="text-text-tertiary" />
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Select project"
        className="absolute inset-0 w-full cursor-pointer opacity-0"
      >
        {projects?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
