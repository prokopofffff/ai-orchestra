import { NavLink } from "react-router-dom";
import { useProjectContext } from "../contexts/ProjectContext";
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
    </header>
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
