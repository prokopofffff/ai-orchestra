import { useProjectContext } from "../contexts/ProjectContext";
import { SignalFeed } from "../components/SignalFeed";
import { EmptyProjects } from "../components/EmptyProjects";

export default function Signals() {
  const { project } = useProjectContext();
  if (!project) return <EmptyProjects />;
  return <SignalFeed projectId={project.id} />;
}
