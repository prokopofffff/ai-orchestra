import { useState, useCallback } from "react";
import { usePolling } from "./hooks/usePolling";
import * as api from "./api";
import type { Project } from "./types";
import { KanbanBoard } from "./components/KanbanBoard";
import { TaskDetail } from "./components/TaskDetail";
import { CreateForms } from "./components/CreateForms";
import { Chat } from "./components/Chat";
import { SignalFeed } from "./components/SignalFeed";
import { AgentGraph } from "./components/AgentGraph";
import { AgentCards } from "./components/AgentCards";
import { TaskQueue } from "./components/TaskQueue";
import { AgentLogs } from "./components/AgentLogs";
import { UsageWidget } from "./components/UsageWidget";

export function App() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [tab, setTab] = useState<"kanban" | "chat" | "signals" | "agents" | "logs">("kanban");

  const projectsFetcher = useCallback(() => api.fetchProjects(), []);
  const { data: projects, refresh: refreshProjects } = usePolling(projectsFetcher, 10000);

  const project = projects?.find((p) => p.id === selectedProjectId) ?? projects?.[0] ?? null;
  const projectId = project?.id ?? null;

  // Auto-select first project
  if (projects?.length && !selectedProjectId) {
    setSelectedProjectId(projects[0].id);
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="logo">AI Orchestra</h1>
        <div className="project-selector">
          <select
            value={projectId ?? ""}
            onChange={(e) => setSelectedProjectId(e.target.value)}
          >
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <nav className="tabs">
          <button className={tab === "kanban" ? "active" : ""} onClick={() => setTab("kanban")}>Kanban</button>
          <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>Chat</button>
          <button className={tab === "signals" ? "active" : ""} onClick={() => setTab("signals")}>Signals</button>
          <button className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>Agents</button>
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>Logs</button>
        </nav>
      </header>

      <main className="main">
        {tab === "kanban" && projectId && (
          <>
            <CreateForms projectId={projectId} onCreated={refreshProjects} />
            <KanbanBoard projectId={projectId} onTaskClick={setSelectedTaskId} />
          </>
        )}

        {tab === "chat" && projectId && (
          <Chat projectId={projectId} />
        )}

        {tab === "signals" && projectId && (
          <SignalFeed projectId={projectId} />
        )}

        {tab === "agents" && projectId && (
          <div className="agents-view">
            <AgentGraph />
            <AgentCards projectId={projectId} />
            <div className="agents-bottom-row">
              <TaskQueue />
              <UsageWidget />
            </div>
          </div>
        )}

        {tab === "logs" && projectId && (
          <AgentLogs projectId={projectId} />
        )}

        {!projectId && (
          <div className="empty-state">
            <h2>No projects yet</h2>
            <p>Create your first project to get started.</p>
            <CreateForms projectId="" onCreated={refreshProjects} />
          </div>
        )}
      </main>

      {selectedTaskId && (
        <TaskDetail
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}
