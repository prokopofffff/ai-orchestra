import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { ProjectProvider } from "./contexts/ProjectContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import { TopBar } from "./components/TopBar";
import { OnboardingHost } from "./components/OnboardingHost";
import { TourHost } from "./components/TourHost";
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
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth />}>
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
        </Route>
      </Routes>
    </AuthProvider>
  );
}

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="grid h-dvh place-items-center bg-bg-page text-text-tertiary text-sm">
        Загрузка…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Outlet />;
}

function AppShell() {
  return (
    <ProjectProvider>
      <TourHost>
        <div className="flex h-dvh flex-col">
          <TopBar />
          <main className="flex-1 min-h-0 overflow-auto">
            <Outlet />
          </main>
          <OnboardingHost />
        </div>
      </TourHost>
    </ProjectProvider>
  );
}
