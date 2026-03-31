import { useState, useCallback } from "react";
import { api } from "./api";
import { usePolling } from "./hooks/usePolling";
import { AgentGraph } from "./components/AgentGraph";
import { AgentCards } from "./components/AgentCards";
import { SignalFeed } from "./components/SignalFeed";
import { TaskQueue } from "./components/TaskQueue";
import { KanbanBoard } from "./components/KanbanBoard";
import { ProjectSelector, CreateTaskForm } from "./components/CreateForms";

export function App() {
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  const sessions = usePolling(useCallback(() => api.sessions(), []), 5000);
  const audit = usePolling(useCallback(() => api.audit(100), []), 5000);
  const queue = usePolling(useCallback(() => api.queue(), []), 10000);
  const projects = usePolling(useCallback(() => api.projects(), []), 10000);
  const tasks = usePolling(
    useCallback(() => api.tasks(selectedProject || undefined), [selectedProject]),
    5000
  );
  const health = usePolling(useCallback(() => api.health(), []), 15000);

  const isConnected = !!health.data && !health.error;

  const refreshAll = () => {
    sessions.refresh();
    audit.refresh();
    queue.refresh();
    tasks.refresh();
    projects.refresh();
  };

  return (
    <div className="app">
      <header className="header">
        <h1>AI Orchestra</h1>
        <div className="header-right">
          <span className={`status-dot ${isConnected ? "connected" : "disconnected"}`} />
          <span>{isConnected ? "Connected" : "Disconnected"}</span>
          <button className="btn-refresh" onClick={refreshAll}>
            Refresh
          </button>
        </div>
      </header>

      <div className="toolbar">
        <ProjectSelector
          projects={projects.data || []}
          selected={selectedProject}
          onSelect={setSelectedProject}
          onRefresh={projects.refresh}
        />
        {selectedProject && (
          <CreateTaskForm projectId={selectedProject} onCreated={tasks.refresh} />
        )}
      </div>

      <div className="main-grid">
        <div className="panel panel-graph">
          <AgentGraph
            sessions={sessions.data || []}
            recentSignals={audit.data || []}
          />
        </div>

        <div className="panel panel-feed">
          <SignalFeed entries={audit.data || []} />
        </div>
      </div>

      <KanbanBoard tasks={tasks.data || []} onRefresh={tasks.refresh} />

      <AgentCards sessions={sessions.data || []} />
      <TaskQueue tasks={queue.data || []} />

      {(sessions.error || audit.error) && (
        <div className="error-bar">
          {sessions.error || audit.error}
        </div>
      )}
    </div>
  );
}
