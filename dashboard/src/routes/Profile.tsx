import { useProjectContext } from "../contexts/ProjectContext";
import { Card } from "../components/ui/Card";

const ME = {
  name: "alice",
  joined: "Jan 2025",
  email: "alice@example.com",
  role: "tech-lead",
  timezone: "Europe/Amsterdam",
} as const;

export default function Profile() {
  const { projects } = useProjectContext();

  return (
    <div className="profile flex gap-12 px-16 py-12">
      <ProfileSidebar />
      <div className="w-px bg-border shrink-0" />
      <main className="flex-1 flex flex-col gap-8 min-w-0">
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-text-primary">Profile Details</h2>
          <Card className="p-6 flex flex-col gap-4">
            <DetailRow label="Email"    value={ME.email} />
            <DetailRow label="Role"     value={ME.role}  mono />
            <DetailRow label="Timezone" value={ME.timezone} mono />
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
  return (
    <aside className="w-[300px] shrink-0 flex flex-col items-center gap-8">
      <div className="h-[120px] w-[120px] rounded-full bg-accent-blue grid place-items-center text-white font-semibold text-5xl">
        {ME.name.slice(0, 1).toUpperCase()}
      </div>
      <div className="text-center flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">{ME.name}</h1>
        <p className="font-mono text-xs text-text-tertiary">
          Member since {ME.joined}
        </p>
      </div>

      <nav className="w-full flex flex-col">
        <SidebarAction label="Account settings" divider />
        <SidebarAction label="Notifications" divider />
        <SidebarAction label="Sign out" danger />
      </nav>
    </aside>
  );
}

function SidebarAction({
  label,
  divider,
  danger,
}: {
  label: string;
  divider?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
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
