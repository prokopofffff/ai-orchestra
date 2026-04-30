import { useNavigate } from "react-router-dom";
import { useProjectContext } from "../contexts/ProjectContext";
import { useAuth } from "../contexts/AuthContext";
import { Card } from "../components/ui/Card";

export default function Profile() {
  const { projects } = useProjectContext();
  const { user } = useAuth();

  if (!user) return null; // RequireAuth has redirected — render nothing while it does

  const joined = user.createdAt.toLocaleDateString(undefined, { month: "short", year: "numeric" });

  return (
    <div className="profile flex gap-12 px-16 py-12">
      <ProfileSidebar />
      <div className="w-px bg-border shrink-0" />
      <main className="flex-1 flex flex-col gap-8 min-w-0">
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-text-primary">Profile Details</h2>
          <Card className="p-6 flex flex-col gap-4">
            <DetailRow label="Username" value={user.username} mono />
            <DetailRow label="Email"    value={user.email} />
            <DetailRow label="Joined"   value={joined} mono />
          </Card>
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-text-primary">My Projects</h2>
            <span className="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
              {projects?.length ?? 0} total
            </span>
          </div>
          <ul className="flex flex-col gap-3">
            {projects?.map((p) => (
              <li key={p.id}>
                <Card className="flex items-center gap-4 px-5 py-4">
                  <div className="h-10 w-10 bg-bg-input border border-border grid place-items-center text-text-secondary font-semibold">
                    {p.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium text-text-primary truncate">{p.name}</span>
                    <span className="font-mono text-[11px] text-text-tertiary truncate">
                      #{p.id.slice(0, 8)}
                      {p.repoUrl ? ` · ${p.repoUrl}` : ""}
                    </span>
                  </div>
                </Card>
              </li>
            ))}
            {(!projects || projects.length === 0) && (
              <li className="text-text-tertiary italic text-sm">No projects yet.</li>
            )}
          </ul>
        </section>
      </main>
    </div>
  );
}

function ProfileSidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  const initial = (user.username || user.email).slice(0, 1).toUpperCase();

  async function handleSignOut() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <aside className="w-[300px] shrink-0 flex flex-col items-center gap-8">
      <div className="h-[120px] w-[120px] rounded-full bg-accent-blue grid place-items-center text-white font-semibold text-5xl">
        {initial}
      </div>
      <div className="text-center flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{user.username}</h1>
        <p className="font-mono text-xs text-text-tertiary">{user.email}</p>
      </div>

      <nav className="w-full flex flex-col">
        <SidebarAction label="Account settings" divider />
        <SidebarAction label="Notifications" divider />
        <SidebarAction label="Sign out" danger onClick={handleSignOut} />
      </nav>
    </aside>
  );
}

function SidebarAction({
  label, divider, danger, onClick,
}: {
  label: string;
  divider?: boolean;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex items-center px-4 py-3.5 text-sm transition-colors text-left",
        divider ? "border-b border-border" : "",
        danger ? "text-accent-red hover:text-accent-red" : "text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center">
      <span className="w-28 shrink-0 text-xs font-medium text-text-secondary uppercase tracking-wider">
        {label}
      </span>
      <span className={`text-sm text-text-primary ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
