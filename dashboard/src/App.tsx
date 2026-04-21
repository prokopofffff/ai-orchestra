import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { ProjectProvider } from "./contexts/ProjectContext";
import { TopBar } from "./components/TopBar";
import Login from "./routes/Login";
import Kanban from "./routes/Kanban";
import ChatRoute from "./routes/Chat";
import Signals from "./routes/Signals";
import Agents from "./routes/Agents";
import Flow from "./routes/Flow";
import Logs from "./routes/Logs";
import Settings from "./routes/Settings";
import Profile from "./routes/Profile";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/kanban" replace />} />
        <Route path="/kanban" element={<Kanban />} />
        <Route path="/chat" element={<ChatRoute />} />
        <Route path="/signals" element={<Signals />} />
        <Route path="/agents" element={<Agents />} />
        <Route path="/flow" element={<Flow />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/kanban" replace />} />
      </Route>
    </Routes>
  );
}

function AppShell() {
  return (
    <ProjectProvider>
      <div className="flex h-dvh flex-col">
        <TopBar />
        <main className="flex-1 min-h-0 overflow-auto">
          <Outlet />
        </main>
      </div>
    </ProjectProvider>
  );
}
