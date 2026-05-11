import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./ui/Button";

/**
 * One step of a coachmark tour. `anchor` is queried against the document
 * with `document.querySelector` — `data-tour="..."` attributes on existing
 * elements are the convention (survives className refactors). If the
 * anchor isn't found at time of step, the step renders centered without a
 * spotlight (graceful fallback for empty/conditional UI).
 */
export type TourStep = {
  anchor?: string;
  title: string;
  body: string;
  /** Override popover placement; default is auto. */
  placement?: "top" | "bottom" | "left" | "right" | "center";
};

interface Props {
  open: boolean;
  steps: TourStep[];
  /** Called on Done or Skip — caller marks the tab seen here. */
  onClose: () => void;
}

/**
 * Generic guided tour. Renders a dimmed overlay with a hole cut around the
 * current step's anchor element, plus a popover near the anchor with title,
 * body, Skip / Back / Next-or-Done. ESC closes (marks tour skipped).
 */
export function Tour({ open, steps, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) setIndex(0);
  }, [open]);

  // Track the anchor's bounding rect — re-measure on scroll/resize, since
  // a coachmark fixed to viewport coords drifts otherwise.
  useLayoutEffect(() => {
    if (!open) return;
    const step = steps[index];
    if (!step?.anchor) { setRect(null); return; }

    let raf = 0;
    const measure = () => {
      const el = document.querySelector(step.anchor!);
      if (el) {
        setRect((el as HTMLElement).getBoundingClientRect());
        (el as HTMLElement).scrollIntoView({ block: "nearest", behavior: "auto" });
      } else {
        setRect(null);
      }
    };
    measure();
    const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(measure); };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, index, steps]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index, steps]);

  if (!open || steps.length === 0) return null;

  const step = steps[index];
  const isLast = index === steps.length - 1;

  function next() {
    if (isLast) onClose();
    else setIndex((i) => i + 1);
  }

  // ─ Layout ─
  // Popover placement: prefer below the anchor; if that overflows the
  // viewport bottom, switch to above. No anchor → center.
  const popover = computePopoverPlacement(rect, step.placement);

  return (
    <>
      {/* Dimmed overlay with a hole around the anchor. Built from four
          divs covering top/right/bottom/left rather than an SVG mask — keeps
          it cheap and lets us catch click-through (clicks land on no-ops, so
          users can't accidentally interact with the spotlight target). */}
      {rect ? (
        <>
          <div className="fixed inset-x-0 top-0 z-[60] bg-black/70" style={{ height: Math.max(0, rect.top - 6) }} />
          <div className="fixed left-0 z-[60] bg-black/70"
               style={{ top: Math.max(0, rect.top - 6), height: rect.height + 12, width: Math.max(0, rect.left - 6) }} />
          <div className="fixed right-0 z-[60] bg-black/70"
               style={{ top: Math.max(0, rect.top - 6), height: rect.height + 12, left: rect.right + 6 }} />
          <div className="fixed inset-x-0 z-[60] bg-black/70"
               style={{ top: rect.bottom + 6, bottom: 0 }} />
          <div
            className="fixed pointer-events-none z-[60] ring-2 ring-accent-blue/70 rounded"
            style={{
              top: rect.top - 6, left: rect.left - 6,
              width: rect.width + 12, height: rect.height + 12,
            }}
          />
        </>
      ) : (
        <div className="fixed inset-0 z-[60] bg-black/70" />
      )}

      <div
        ref={popoverRef}
        role="dialog"
        aria-modal="true"
        className="fixed z-[61] bg-bg-surface border border-border w-[360px] max-w-[calc(100vw-32px)] p-4 flex flex-col gap-3 shadow-xl"
        style={popover.style}
      >
        <header className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold text-text-primary">{step.title}</h3>
          <span className="font-mono text-[11px] text-text-tertiary shrink-0">
            {index + 1} / {steps.length}
          </span>
        </header>

        <p className="text-[13px] leading-relaxed text-text-secondary whitespace-pre-wrap">
          {step.body}
        </p>

        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] text-text-tertiary hover:text-text-primary"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setIndex((i) => i - 1)}>
                Back
              </Button>
            )}
            <Button variant="primary-red" size="sm" onClick={next}>
              {isLast ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function computePopoverPlacement(
  rect: DOMRect | null,
  override?: TourStep["placement"],
): { style: React.CSSProperties } {
  const W = 360, H = 180, gap = 12;
  const vw = window.innerWidth, vh = window.innerHeight;

  if (!rect || override === "center") {
    return { style: { top: Math.max(16, vh / 2 - H / 2), left: Math.max(16, vw / 2 - W / 2) } };
  }

  // Auto: prefer below if there's room, else above.
  const wantedPlacement =
    override ?? (vh - rect.bottom > H + gap + 16 ? "bottom"
              : rect.top > H + gap + 16 ? "top"
              : vw - rect.right > W + gap + 16 ? "right"
              : "left");

  let top = 0, left = 0;
  switch (wantedPlacement) {
    case "bottom":
      top = rect.bottom + gap;
      left = clamp(rect.left + rect.width / 2 - W / 2, 16, vw - W - 16);
      break;
    case "top":
      top = rect.top - gap - H;
      left = clamp(rect.left + rect.width / 2 - W / 2, 16, vw - W - 16);
      break;
    case "right":
      top = clamp(rect.top + rect.height / 2 - H / 2, 16, vh - H - 16);
      left = rect.right + gap;
      break;
    case "left":
      top = clamp(rect.top + rect.height / 2 - H / 2, 16, vh - H - 16);
      left = rect.left - gap - W;
      break;
  }
  return { style: { top, left } };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
