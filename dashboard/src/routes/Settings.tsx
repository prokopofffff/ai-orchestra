import { useProjectContext } from "../contexts/ProjectContext";
import { ProjectChecks } from "../components/ProjectChecks";
import { EmptyProjects } from "../components/EmptyProjects";

export default function Settings() {
  const { project } = useProjectContext();
  if (!project) return <EmptyProjects />;
  return <ProjectChecks projectId={project.id} />;
}
