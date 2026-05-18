import { useQueryClient } from "@tanstack/react-query";
import { CreateForms } from "./CreateForms";

/** Shown on data routes when no project is selected yet. */
export function EmptyProjects() {
  const qc = useQueryClient();
  return (
    <div className="flex flex-col items-center gap-4 p-16 text-center">
      <h2 className="text-xl font-semibold text-text-primary">Пока нет проектов</h2>
      <p className="text-sm text-text-secondary">
        Создайте свой первый проект, чтобы начать.
      </p>
      <div className="mt-4 w-full max-w-2xl">
        <CreateForms
          projectId=""
          onCreated={() => qc.invalidateQueries({ queryKey: ["projects"] })}
        />
      </div>
    </div>
  );
}
