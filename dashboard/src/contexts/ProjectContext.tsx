import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api";
import type { Project } from "../types";

/**
 * localStorage key holding the most recently selected project id. Restored
 * on mount so a page reload doesn't snap to the API-default project (which
 * is the newest, surprising users who were working on something older).
 */
const SELECTED_PROJECT_STORAGE_KEY = "orchestra:selectedProjectId";

function readStoredProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
  } catch {
    // Storage may be disabled (private mode, quota exceeded, etc.) — fall
    // back to the auto-pick path instead of crashing the provider.
    return null;
  }
}

function writeStoredProjectId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, id);
    else window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
  } catch {
    // Same reason as readStoredProjectId — best-effort.
  }
}

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
  // Initialise from localStorage so a reload restores the user's last
  // selection. Validity against the actual project list is checked once
  // projects load, below.
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(() => readStoredProjectId());

  const setSelectedProjectId = useCallback((id: string): void => {
    setSelectedProjectIdState(id);
    writeStoredProjectId(id);
  }, []);

  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: api.fetchProjects,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!projects?.length) return;
    // If the persisted / current selection isn't in the visible list
    // (project deleted, switched users, link from outside), fall back to
    // the first project so the UI never lands on a non-existent state.
    const exists = selectedProjectId && projects.some((p) => p.id === selectedProjectId);
    if (!exists) {
      setSelectedProjectIdState(projects[0].id);
      writeStoredProjectId(projects[0].id);
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
    setSelectedProjectId(created.id);  // also persists via the wrapped setter
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
