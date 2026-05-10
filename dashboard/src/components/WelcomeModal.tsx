import { useState } from "react";
import { Button } from "./ui/Button";

/**
 * One-time intro shown to fresh signups before they've created a project.
 * Three quick slides set the mental model: what AI Orchestra is, how the
 * agents work together, what to do next. Closable any time — the checklist
 * widget on the dashboard takes over from there.
 */
export function WelcomeModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const slides = [
    {
      title: "Welcome to AI Orchestra",
      body: "An autonomous dev team that runs in your repo. You describe what you want — Tech Lead breaks it down and coordinates a crew of specialized AI agents to ship it.",
    },
    {
      title: "How it works",
      body: "You chat with Tech Lead. They plan, hand parts off to Frontend, Backend, QA, DevOps, or Designer agents, and bring you back PRs to review. Every action is observable in real time.",
    },
    {
      title: "Three steps to get started",
      body: "Configure how Claude is billed (Max subscription or API key), point us at a repo or local directory, and add a GitHub/GitLab token if you're using a remote. Then send Tech Lead your first message.",
    },
  ];
  const isLast = step === slides.length - 1;
  const slide = slides[step];

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-6"
      onClick={onClose}
    >
      <div
        className="welcome-modal relative bg-bg-surface border border-border w-full max-w-[520px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          aria-label="Close"
          onClick={onClose}
          className="absolute top-3 right-3 text-text-tertiary hover:text-text-primary text-xl leading-none"
        >
          ×
        </button>

        <div className="px-8 pt-10 pb-6 flex flex-col gap-3 min-h-[220px]">
          <span className="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
            Step {step + 1} of {slides.length}
          </span>
          <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
            {slide.title}
          </h2>
          <p className="text-sm leading-relaxed text-text-secondary">
            {slide.body}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border bg-bg-page px-6 py-3">
          <div className="flex gap-1.5">
            {slides.map((_, i) => (
              <span
                key={i}
                className={["h-1.5 w-6 transition-colors",
                  i === step ? "bg-accent-blue" : "bg-bg-input",
                ].join(" ")}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="primary-blue"
              size="sm"
              onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))}
              type="button"
            >
              {step === 0 ? "Skip" : "Back"}
            </Button>
            <Button
              variant="primary-red"
              size="sm"
              onClick={() => (isLast ? onClose() : setStep((s) => s + 1))}
              type="button"
            >
              {isLast ? "Get started" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
