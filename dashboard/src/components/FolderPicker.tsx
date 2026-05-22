import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import { Button } from "./ui/Button";

// Tiny path.join shim — we render absolute posix-style paths from the
// orchestra-core host (linux/macOS), so a bare string concat is enough.
// Pulling in `path-browserify` for one call site isn't worth the dep.
function path_join(base: string, rel: string): string {
  if (!rel) return base;
  return base.endsWith("/") ? base + rel : base + "/" + rel;
}

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
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const newNameInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["fs-browse", path, showHidden],
    queryFn: () => api.browseFs(path, showHidden),
    retry: false,
  });

  useEffect(() => {
    if (creating) newNameInputRef.current?.focus();
  }, [creating]);

  const cancelCreate = (): void => {
    setCreating(false);
    setNewName("");
    setCreateError(null);
  };

  const submitCreate = async (): Promise<void> => {
    const cwd = data?.cwd;
    const name = newName.trim();
    if (!cwd || !name) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const { path: created } = await api.createFsDir(cwd, name);
      cancelCreate();
      await refetch();
      // Navigate into the freshly created folder — it's the path the user
      // is almost certainly about to pick.
      setPath(created);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Не удалось создать папку");
    } finally {
      setCreateBusy(false);
    }
  };

  // Auto-correct: if the requested path errored (deleted out from under
  // us, no permission), fall back to home so the modal stays usable.
  useEffect(() => {
    if (error && path !== undefined) setPath(undefined);
  }, [error, path]);

  const cwd = data?.cwd ?? "";
  const workspaceRoot = data?.workspaceRoot ?? null;
  // When a workspace root is configured (server-clamped browsing), render
  // breadcrumbs relative to it instead of from "/". The leftmost crumb is
  // the workspace root itself; segments above the root never appear.
  const allSegments = cwd ? cwd.split("/").filter(Boolean) : [];
  const rootSegments = workspaceRoot ? workspaceRoot.split("/").filter(Boolean) : [];
  const segments = workspaceRoot ? allSegments.slice(rootSegments.length) : allSegments;
  const homeLabel = workspaceRoot ? "⌂ Рабочая директория" : "~ Домашняя папка";
  const homePath = workspaceRoot ?? data?.home;

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
          <h2 className="text-sm font-semibold text-text-primary">Выберите папку проекта</h2>
          <button
            aria-label="Закрыть"
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
            onClick={() => setPath(workspaceRoot ?? "/")}
            className="text-text-tertiary hover:text-text-primary"
            title={workspaceRoot ?? "/"}
          >
            {workspaceRoot ? "⌂" : "/"}
          </button>
          {segments.map((seg, i) => {
            const rel = segments.slice(0, i + 1).join("/");
            const next = workspaceRoot ? path_join(workspaceRoot, rel) : "/" + rel;
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
          {homePath && (
            <button
              type="button"
              onClick={() => setPath(homePath)}
              className="ml-auto text-[11px] text-text-tertiary hover:text-text-primary px-2 py-0.5 border border-border-subtle"
            >
              {homeLabel}
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {isLoading && (
            <div className="p-6 text-sm text-text-tertiary">Загрузка...</div>
          )}
          {error && (
            <div className="p-6 text-sm text-accent-red">
              {error instanceof Error ? error.message : "Не удалось прочитать директорию."}
              <button
                type="button"
                onClick={() => refetch()}
                className="ml-2 text-text-tertiary hover:text-text-primary underline"
              >
                Повторить
              </button>
            </div>
          )}
          {data && (
            <ul className="folder-entries">
              {creating && (
                <li className="px-5 py-2 border-b border-border-subtle bg-bg-hover/20">
                  <div className="flex items-center gap-2">
                    <span aria-hidden>📁</span>
                    <input
                      ref={newNameInputRef}
                      type="text"
                      value={newName}
                      onChange={(e) => { setNewName(e.target.value); setCreateError(null); }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void submitCreate(); }
                        else if (e.key === "Escape") { e.preventDefault(); cancelCreate(); }
                      }}
                      placeholder="имя новой папки"
                      disabled={createBusy}
                      className="flex-1 bg-bg-input border border-border px-2 py-1 text-sm text-text-primary font-mono outline-none focus:border-accent-red"
                    />
                    <Button
                      variant="primary-red"
                      size="sm"
                      disabled={createBusy || !newName.trim()}
                      onClick={() => void submitCreate()}
                    >
                      {createBusy ? "..." : "Создать"}
                    </Button>
                    <button
                      type="button"
                      onClick={cancelCreate}
                      disabled={createBusy}
                      className="text-text-tertiary hover:text-text-primary text-xs px-2 py-1"
                    >
                      Отмена
                    </button>
                  </div>
                  {createError && (
                    <div className="mt-1 text-xs text-accent-red">{createError}</div>
                  )}
                </li>
              )}
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
                  Здесь нет подпапок.
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
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-[11px] text-text-tertiary">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="accent-accent-red"
              />
              Показывать скрытые
            </label>
            <button
              type="button"
              onClick={() => { setCreating(true); setNewName(""); setCreateError(null); }}
              disabled={!cwd || creating}
              className="text-[11px] text-text-tertiary hover:text-text-primary px-2 py-0.5 border border-border-subtle disabled:opacity-50"
            >
              + Создать папку
            </button>
          </div>
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
Выбрать эту папку
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
