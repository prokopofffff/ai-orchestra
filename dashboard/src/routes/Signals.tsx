import { useProjectContext } from "../contexts/ProjectContext";
import { SignalFeed } from "../components/SignalFeed";
import { EmptyProjects } from "../components/EmptyProjects";

export default function Signals() {
  const { project } = useProjectContext();
  if (!project) return <EmptyProjects />;
  return (
    <div data-tour="signals.feed" className="h-full">
      <SignalFeed projectId={project.id} />
    </div>
  );
}
