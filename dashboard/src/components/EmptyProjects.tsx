import { useQueryClient } from "@tanstack/react-query";
import { CreateForms } from "./CreateForms";

/** Shown on data routes when no project is selected yet. */
export function EmptyProjects() {
  const qc = useQueryClient();
  return (
    <div className="empty-state">
      <h2>No projects yet</h2>
      <p>Create your first project to get started.</p>
      <CreateForms
        projectId=""
        onCreated={() => qc.invalidateQueries({ queryKey: ["projects"] })}
      />
    </div>
  );
}
