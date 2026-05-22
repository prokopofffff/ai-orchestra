import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ROLE_COLORS, ROLE_FALLBACK } from "../types";
import { Button } from "./ui/Button";
import { ChevronDownIcon, DownloadIcon, RefreshIcon, SearchIcon } from "./ui/Icon";

interface LogEntry {
  id: string;
  projectId: string;
  sessionId: string | null;
  role: string;
  level: "stdout" | "stderr" | "system" | "error";
  message: string;
  createdAt: string;
}

interface Props {
  projectId: string;
}

const LEVEL_COLORS: Record<string, string> = {
  stdout: "var(--color-text-primary)",
  stderr: "var(--color-accent-red)",
  system: "var(--color-text-tertiary)",
  error:  "var(--color-accent-red)",
};

const ROLES  = ["tech-lead", "designer", "frontend", "backend", "qa", "devops"];
const LEVELS = ["stdout", "stderr", "system", "error"];

export function AgentLogs({ projectId }: Props) {
  const [roleFilter, setRoleFilter]   = useState<string>("");
  const [levelFilter, setLevelFilter] = useState<string>("");
  const [search, setSearch]           = useState<string>("");
  const [autoScroll, setAutoScroll]   = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: logs } = useQuery({
    queryKey: ["logs", projectId, roleFilter, levelFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ projectId, limit: "300" });
      if (roleFilter)  params.set("role", roleFilter);
      if (levelFilter) params.set("level", levelFilter);
      const res = await fetch(`/api/logs?${params}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as LogEntry[];
    },
    refetchInterval: 3_000,
  });

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs?.length, autoScroll]);

  const displayLogs = logs ? [...logs].reverse() : [];
  const searchLower = search.trim().toLowerCase();
  const filtered = searchLower
    ? displayLogs.filter((l) => l.message.toLowerCase().includes(searchLower))
    : displayLogs;

  const exportFiltered = (): void => {
    if (!filtered.length) return;
    // Mirror the on-screen format so the file matches what the user sees.
    // ISO timestamps for grep/sort; one log line per row.
    const body = filtered
      .map((l) => `${l.createdAt}\t${l.role}\t${l.level}\t${l.message.replace(/\n/g, "\\n")}`)
      .join("\n");
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const tag = [roleFilter, levelFilter, searchLower && "search"].filter(Boolean).join("-") || "all";
    a.download = `orchestra-logs-${projectId.slice(0, 8)}-${tag}-${stamp}.tsv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="agent-logs flex flex-col gap-5 px-10 py-7 h-full min-h-0">
      <header className="logs-header flex items-center justify-between">
        <h2 className="text-[22px] font-semibold tracking-tight text-text-primary">
          Логи агентов
        </h2>
        <Button
          variant="secondary"
          leadingIcon={<DownloadIcon size={14} />}
          disabled={!filtered.length}
          onClick={exportFiltered}
          title={filtered.length ? `Скачать ${filtered.length} записей` : "Нет логов для экспорта"}
        >
          Экспорт
        </Button>
      </header>

      <div className="logs-filters flex items-center gap-3 flex-wrap">
        <div className="relative">
          <SearchIcon
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по логам…"
            className="h-9 w-[280px] pl-9 pr-3 bg-bg-input border border-border text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent-blue"
          />
        </div>

        <PillSelect
          value={roleFilter}
          onChange={setRoleFilter}
          placeholder="Все роли"
          options={ROLES}
          activeStyle="blue"
        />

        <PillSelect
          value={levelFilter}
          onChange={setLevelFilter}
          placeholder="Все уровни"
          options={LEVELS}
          activeStyle="border"
        />

        <label className="auto-scroll inline-flex items-center gap-2 h-9 px-3.5 border border-border text-xs text-text-secondary cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="accent-accent-green"
          />
          <RefreshIcon size={12} className="text-accent-green" />
          Автопрокрутка
        </label>
      </div>

      <div className="logs-container flex-1 min-h-0 bg-bg-surface border border-border-subtle flex flex-col overflow-hidden">
        <div className="grid shrink-0 bg-bg-card border-b border-border h-10 items-center px-5 gap-4 font-mono text-[11px] uppercase tracking-wider text-text-tertiary"
             style={{ gridTemplateColumns: "140px 120px 80px 1fr" }}>
          <span>Время</span>
          <span>Роль</span>
          <span>Уровень</span>
          <span>Сообщение</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map((log) => (
            <div
              key={log.id}
              className={[
                "log-entry",
                `level-${log.level}`,
                "grid items-center px-5 gap-4 min-h-11 py-2",
                "border-b border-border-subtle text-xs",
                (log.level === "stderr" || log.level === "error") && "bg-accent-red/[0.06]",
              ].filter(Boolean).join(" ")}
              style={{ gridTemplateColumns: "140px 120px 80px 1fr" }}
            >
              <span className="log-time font-mono text-[11px] text-text-tertiary">
                {new Date(log.createdAt).toLocaleTimeString()}
              </span>
              <span
                className="log-role font-mono text-[11px] font-medium truncate"
                style={{ color: ROLE_COLORS[log.role] ?? ROLE_FALLBACK }}
              >
                {log.role}
              </span>
              <span
                className="log-level font-mono text-[11px] uppercase"
                style={{ color: LEVEL_COLORS[log.level] }}
              >
                [{log.level}]
              </span>
              <span className="log-message font-mono text-[12px] text-text-primary break-all whitespace-pre-wrap">
                {log.message}
              </span>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="empty text-text-tertiary italic p-4">Логов пока нет</div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

function PillSelect({
  value,
  onChange,
  placeholder,
  options,
  activeStyle,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: string[];
  activeStyle: "blue" | "border";
}) {
  const active = value !== "";
  const visible = active ? value : placeholder;

  const styleCls = active
    ? activeStyle === "blue"
      ? "bg-accent-blue text-white border-accent-blue"
      : "bg-bg-surface text-text-primary border-text-secondary"
    : "bg-bg-surface text-text-secondary border-border hover:text-text-primary";

  return (
    <label className="relative inline-flex items-center">
      <span
        aria-hidden="true"
        className={[
          "inline-flex items-center gap-1.5 h-9 px-3.5 border text-[11px] font-medium",
          styleCls,
        ].join(" ")}
      >
        {visible}
        <ChevronDownIcon size={12} />
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 w-full h-full cursor-pointer opacity-0"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}
