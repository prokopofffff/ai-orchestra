import { useProjectContext } from "../contexts/ProjectContext";
import { AgentGraph } from "../components/AgentGraph";
import { AgentCards } from "../components/AgentCards";
import { TaskQueue } from "../components/TaskQueue";
import { UsageWidget } from "../components/UsageWidget";
import { EmptyProjects } from "../components/EmptyProjects";

export default function Agents() {
  const { project } = useProjectContext();
  if (!project) return <EmptyProjects />;
  return (
    <div className="agents-view flex flex-col gap-6 px-12 py-8">
      <AgentGraph />
      <AgentCards projectId={project.id} />
      <div className="agents-bottom-row grid grid-cols-2 gap-6">
        <TaskQueue />
        <UsageWidget />
      </div>
    </div>
  );
}
