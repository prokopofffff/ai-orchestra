import { useProjectContext } from "../contexts/ProjectContext";
import { Chat } from "../components/Chat";
import { EmptyProjects } from "../components/EmptyProjects";

export default function ChatRoute() {
  const { project } = useProjectContext();
  if (!project) return <EmptyProjects />;
  return (
    <div className="p-5 h-full">
      <Chat projectId={project.id} />
    </div>
  );
}
