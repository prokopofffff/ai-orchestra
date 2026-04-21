import { useProjectContext } from "../contexts/ProjectContext";
import { AgentLogs } from "../components/AgentLogs";
import { EmptyProjects } from "../components/EmptyProjects";

export default function Logs() {
  const { project } = useProjectContext();
  if (!project) return <EmptyProjects />;
  return (
    <div className="h-full min-h-0">
      <AgentLogs projectId={project.id} />
    </div>
  );
}
