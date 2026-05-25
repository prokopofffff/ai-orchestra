import { useProjectContext } from "../contexts/ProjectContext";
import { Chat } from "../components/Chat";
import { EmptyProjects } from "../components/EmptyProjects";

export default function ChatRoute() {
  const { projects, project, setSelectedProjectId } = useProjectContext();
  if (!project) return <EmptyProjects />;

  return (
    <div className="flex h-full min-h-0">
      <ChatSidebar
        projects={projects ?? []}
        activeId={project.id}
        onSelect={setSelectedProjectId}
      />
      <div className="flex-1 min-w-0">
        <Chat projectId={project.id} title={project.name} />
      </div>
    </div>
  );
}

function ChatSidebar({
  projects,
  activeId,
  onSelect,
}: {
  projects: { id: string; name: string }[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside data-tour="chat.sidebar" className="w-[280px] shrink-0 min-h-0 bg-bg-sidebar border-r border-border py-4 flex flex-col">
      <div className="shrink-0 flex items-center justify-between px-4">
        <span className="text-[14px] font-semibold text-text-primary">Беседы</span>
      </div>

      <ul className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5 px-2 py-3">
        {projects.map((p) => {
          const active = p.id === activeId;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                className={[
                  "w-full text-left px-3 py-2.5 flex flex-col gap-1",
                  active
                    ? "bg-bg-hover text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover/60 hover:text-text-primary",
                ].join(" ")}
              >
                <span className="text-[13px] font-medium truncate">{p.name}</span>
                <span className="font-mono text-[11px] text-text-tertiary truncate">
                  #{p.id.slice(0, 8)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
