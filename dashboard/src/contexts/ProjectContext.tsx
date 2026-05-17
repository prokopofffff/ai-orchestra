import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type { Project } from "../types";

interface ProjectContextValue {
  projects: Project[] | undefined;
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string) => void;
  project: Project | null;
  /**
   * Create a project and switch to it in one step. The new project is
   * written into the React Query cache synchronously and selected
   * immediately, so the UI flips from EmptyProjects to the project view
   * the moment the request resolves — no waiting on the 10-second
   * refetch cycle to notice.
   */
  createProject: (data: { name: string; repoUrl?: string; localPath?: string }) => Promise<Project>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: api.fetchProjects,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!selectedProjectId && projects?.length) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const project = projects?.find((p) => p.id === selectedProjectId) ?? null;

  const createProject = async (data: { name: string; repoUrl?: string; localPath?: string }): Promise<Project> => {
    const created = await api.createProject(data);
    // Inject into the query cache so the projects list reflects it right
    // away — the next paint already sees the new entry without waiting
    // for a server round-trip. De-dupe by id in case a refetch raced.
    queryClient.setQueryData<Project[]>(["projects"], (old) => {
      const others = (old ?? []).filter((p) => p.id !== created.id);
      return [created, ...others];
    });
    setSelectedProjectId(created.id);
    return created;
  };

  return (
    <ProjectContext.Provider
      value={{ projects, selectedProjectId, setSelectedProjectId, project, createProject }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjectContext() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectContext must be used inside <ProjectProvider>");
  return ctx;
}
