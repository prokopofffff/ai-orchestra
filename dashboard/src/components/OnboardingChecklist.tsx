import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import * as api from "../api";
import { CheckCircleIcon, CircleIcon } from "./ui/Icon";

/**
 * Persistent "Getting started" widget. Renders nothing once the user has
 * either dismissed it or completed every step. Auto-refreshes when the
 * underlying state changes (queryKey shared with anything that mutates
 * projects / system_config).
 */
export function OnboardingChecklist() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["onboarding"],
    queryFn: api.fetchOnboarding,
    refetchInterval: 15_000,
  });
  const [dismissing, setDismissing] = useState(false);

  if (isLoading || !data) return null;
  if (data.dismissedAt) return null;
  if (data.allDone) return null;

  async function dismiss() {
    setDismissing(true);
    try {
      await api.dismissOnboarding();
      await queryClient.invalidateQueries({ queryKey: ["onboarding"] });
    } finally {
      setDismissing(false);
    }
  }

  const completed = data.steps.filter((s) => s.done).length;

  return (
    <section className="onboarding-checklist flex flex-col gap-3 bg-bg-surface border border-border p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-text-primary">Начало работы</h3>
          <span className="font-mono text-[11px] text-text-tertiary">
            {completed} из {data.steps.length} выполнено
          </span>
        </div>
        <button
          onClick={dismiss}
          disabled={dismissing}
          className="text-[11px] text-text-tertiary hover:text-text-primary"
          aria-label="Скрыть онбординг"
          type="button"
        >
          Скрыть
        </button>
      </header>

      <ul className="flex flex-col">
        {data.steps.map((step) => (
          <li key={step.key} className="onboarding-step border-t border-border-subtle first:border-t-0">
            <Link
              to={step.href}
              className={[
                "flex items-start gap-3 py-2.5 transition-colors",
                step.done ? "opacity-60" : "hover:bg-bg-hover/40",
              ].join(" ")}
            >
              <span className="mt-0.5 shrink-0">
                {step.done
                  ? <CheckCircleIcon size={16} className="text-accent-green" />
                  : <CircleIcon size={16} className="text-text-tertiary" />}
              </span>
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className={[
                  "text-[13px]",
                  step.done ? "line-through text-text-tertiary" : "text-text-primary",
                ].join(" ")}>
                  {step.title}
                </span>
                {step.hint && (
                  <span className="text-[11px] text-text-tertiary">{step.hint}</span>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
