import { useNavigate } from "react-router-dom";

/** Commit 3 will replace this placeholder with the branding-panel design. */
export default function Login() {
  const navigate = useNavigate();
  return (
    <main className="min-h-dvh grid place-items-center">
      <button
        className="px-6 py-3 bg-accent-blue text-text-on-accent rounded-sm text-sm font-medium"
        onClick={() => navigate("/kanban")}
      >
        Enter dashboard
      </button>
    </main>
  );
}
