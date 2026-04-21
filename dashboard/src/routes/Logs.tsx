import { useProjectContext } from "../contexts/ProjectContext";
import { AgentLogs } from "../components/AgentLogs";
import { EmptyProjects } from "../components/EmptyProjects";

export default function Logs() {
  const { project } = useProjectContext();
  if (!project) return <EmptyProjects />;
  return (
    <div className="p-5 h-full">
      <AgentLogs projectId={project.id} />
    </div>
  );
}
