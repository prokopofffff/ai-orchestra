import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "../contexts/ProjectContext";
import { KanbanBoard } from "../components/KanbanBoard";
import { CreateForms } from "../components/CreateForms";
import { TaskDetail } from "../components/TaskDetail";
import { EmptyProjects } from "../components/EmptyProjects";

export default function Kanban() {
  const { project } = useProjectContext();
  const qc = useQueryClient();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  if (!project) return <EmptyProjects />;

  const refresh = () => qc.invalidateQueries({ queryKey: ["projects"] });

  return (
    <div className="flex flex-col h-full min-h-0">
      <CreateForms projectId={project.id} onCreated={refresh} />
      <div className="flex-1 min-h-0 p-4" data-tour="kanban.board">
        <KanbanBoard projectId={project.id} onTaskClick={setSelectedTaskId} />
      </div>
      {selectedTaskId && (
        <TaskDetail taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      )}
    </div>
  );
}
