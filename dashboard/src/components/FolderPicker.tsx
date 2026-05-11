import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { Button } from "./ui/Button";

interface Props {
  /** Initial directory; defaults to the user's home on the server. */
  initialPath?: string;
  onSelect: (absolutePath: string) => void;
  onClose: () => void;
}

/**
 * Server-driven folder picker. The orchestra-core process lives on the
 * machine the agents will work on, so its filesystem view IS the one we
 * want for `local_path`. Browsers don't expose absolute paths from native
 * folder pickers, so the modal walks directories through /api/fs/browse
 * and the user picks an absolute path that the backend later uses to
 * create git worktrees from.
 */
export function FolderPicker({ initialPath, onSelect, onClose }: Props) {
  const [path, setPath] = useState<string | undefined>(initialPath);
  const [showHidden, setShowHidden] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["fs-browse", path, showHidden],
    queryFn: () => api.browseFs(path, showHidden),
    retry: false,
  });

  // Auto-correct: if the requested path errored (deleted out from under
  // us, no permission), fall back to home so the modal stays usable.
  useEffect(() => {
    if (error && path !== undefined) setPath(undefined);
  }, [error, path]);

  const cwd = data?.cwd ?? "";
  const segments = cwd ? cwd.split("/").filter(Boolean) : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-6"
      onClick={onClose}
    >
      <div
        className="folder-picker bg-bg-surface border border-border w-full max-w-[640px] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">Select a project folder</h2>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary text-xl leading-none"
          >
            ×
          </button>
        </header>

        {/* Breadcrumbs — clickable to jump up any number of levels at once. */}
        <div className="path-bar flex items-center gap-1 flex-wrap px-5 py-2 border-b border-border-subtle text-xs font-mono">
          <button
            type="button"
            onClick={() => setPath("/")}
            className="text-text-tertiary hover:text-text-primary"
          >
            /
          </button>
          {segments.map((seg, i) => {
            const next = "/" + segments.slice(0, i + 1).join("/");
            return (
              <span key={i} className="flex items-center gap-1">
                <span className="text-text-tertiary">›</span>
                <button
                  type="button"
                  onClick={() => setPath(next)}
                  className="text-text-secondary hover:text-text-primary"
                >
                  {seg}
                </button>
              </span>
            );
          })}
          {data?.home && (
            <button
              type="button"
              onClick={() => setPath(data.home)}
              className="ml-auto text-[11px] text-text-tertiary hover:text-text-primary px-2 py-0.5 border border-border-subtle"
            >
              ~ Home
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {isLoading && (
            <div className="p-6 text-sm text-text-tertiary">Loading…</div>
          )}
          {error && (
            <div className="p-6 text-sm text-accent-red">
              {error instanceof Error ? error.message : "Failed to read directory."}
              <button
                type="button"
                onClick={() => refetch()}
                className="ml-2 text-text-tertiary hover:text-text-primary underline"
              >
                Retry
              </button>
            </div>
          )}
          {data && (
            <ul className="folder-entries">
              {data.parent && (
                <li>
                  <button
                    type="button"
                    onClick={() => setPath(data.parent!)}
                    className="w-full flex items-center gap-2 px-5 py-2 text-sm text-text-secondary hover:bg-bg-hover/40"
                  >
                    <span aria-hidden>↑</span>
                    <span className="font-mono text-text-tertiary">..</span>
                  </button>
                </li>
              )}
              {data.entries.length === 0 ? (
                <li className="px-5 py-6 text-xs text-text-tertiary">
                  No subdirectories here.
                </li>
              ) : data.entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    onClick={() => setPath(e.path)}
                    className="w-full flex items-center gap-2 px-5 py-2 text-sm hover:bg-bg-hover/40 text-text-primary"
                  >
                    <span aria-hidden>📁</span>
                    <span className="truncate">{e.name}</span>
                    {e.isGitRepo && (
                      <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-accent-green border border-accent-green/40 px-1.5 py-0.5">
                        git
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border">
          <label className="flex items-center gap-2 text-[11px] text-text-tertiary">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              className="accent-accent-red"
            />
            Show hidden
          </label>
          <div className="flex items-center gap-3 min-w-0">
            <code className="font-mono text-[11px] text-text-tertiary truncate max-w-[280px]" title={cwd}>
              {cwd}
            </code>
            <Button
              variant="primary-red"
              size="sm"
              disabled={!cwd}
              onClick={() => { onSelect(cwd); onClose(); }}
            >
              Select this folder
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
