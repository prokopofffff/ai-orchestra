import { useProjectContext } from "../contexts/ProjectContext";
import { SignalFeed } from "../components/SignalFeed";
import { EmptyProjects } from "../components/EmptyProjects";

export default function Signals() {
  const { project } = useProjectContext();
  if (!project) return <EmptyProjects />;
  return (
    <div className="p-5">
      <SignalFeed projectId={project.id} />
    </div>
  );
}
