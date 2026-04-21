import { useState } from "react";
import { useProjectContext } from "../contexts/ProjectContext";
import { KanbanBoard } from "../components/KanbanBoard";
import { CreateForms } from "../components/CreateForms";
import { TaskDetail } from "../components/TaskDetail";
import { EmptyProjects } from "../components/EmptyProjects";

export default function Kanban() {
  const { project } = useProjectContext();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  if (!project) return <EmptyProjects />;

  return (
    <>
      <div className="p-5">
        <CreateForms projectId={project.id} onCreated={() => {}} />
        <KanbanBoard projectId={project.id} onTaskClick={setSelectedTaskId} />
      </div>
      {selectedTaskId && (
        <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      )}
    </>
  );
}
