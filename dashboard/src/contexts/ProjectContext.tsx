import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
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

/**
 * Local key for the last project the user opened. Survives page reloads
 * so the user doesn't get yanked to "most recently created" — the previous
 * behaviour, since the projects query returns newest first and the
 * fallback picks `projects[0]`. Per-browser, not per-user, but the dashboard
 * is single-tenant in practice so name collisions don't matter.
 */
const SELECTED_PROJECT_KEY = "orchestra:selectedProjectId";

function readPersistedProjectId(): string | null {
  try { return window.localStorage.getItem(SELECTED_PROJECT_KEY); }
  catch { return null; }
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Read the persisted choice during state init so the very first render
  // already has the right id — avoids a one-frame flash of "wrong project".
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(readPersistedProjectId);

  const setSelectedProjectId = useCallback((id: string) => {
    setSelectedProjectIdState(id);
    try { window.localStorage.setItem(SELECTED_PROJECT_KEY, id); }
    catch { /* private mode / storage quota — best-effort persistence */ }
  }, []);

  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: api.fetchProjects,
    refetchInterval: 10_000,
  });

  // When projects load, pin the selection to whatever the user actually has
  // access to. Three cases:
  //   - persisted id is still valid → keep it (no-op)
  //   - persisted id is gone (project deleted, lost access) → fall to projects[0]
  //   - nothing persisted → fall to projects[0] (first-time visit)
  useEffect(() => {
    if (!projects?.length) return;
    const stillValid = selectedProjectId && projects.some((p) => p.id === selectedProjectId);
    if (!stillValid) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId, setSelectedProjectId]);

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
