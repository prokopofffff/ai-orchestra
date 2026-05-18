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
      title: "Добро пожаловать в AI Orchestra",
      body: "Автономная команда разработки, работающая в Вашем репозитории. Вы описываете, что хотите, — Tech Lead разбивает задачу на части и координирует команду специализированных AI-агентов, чтобы её выполнить.",
    },
    {
      title: "Как это работает",
      body: "Вы общаетесь с Tech Lead. Он планирует, передаёт части работы агентам Frontend, Backend, QA, DevOps или Designer и возвращает Вам PR на ревью. Каждое действие наблюдаемо в реальном времени.",
    },
    {
      title: "Три шага, чтобы начать",
      body: "Настройте, как оплачивается Claude (подписка Max или API-ключ), укажите репозиторий или локальную директорию и добавьте токен GitHub/GitLab, если используете удалённый репозиторий. Затем отправьте первое сообщение Tech Lead.",
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
          aria-label="Закрыть"
          onClick={onClose}
          className="absolute top-3 right-3 text-text-tertiary hover:text-text-primary text-xl leading-none"
        >
          ×
        </button>

        <div className="px-8 pt-10 pb-6 flex flex-col gap-3 min-h-[220px]">
          <span className="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
            Шаг {step + 1} из {slides.length}
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
              {step === 0 ? "Пропустить" : "Назад"}
            </Button>
            <Button
              variant="primary-red"
              size="sm"
              onClick={() => (isLast ? onClose() : setStep((s) => s + 1))}
              type="button"
            >
              {isLast ? "Начать" : "Далее"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
