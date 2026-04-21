import { Suspense, lazy } from "react";

const FlowDiagram = lazy(() =>
  import("../components/FlowDiagram").then((m) => ({ default: m.FlowDiagram })),
);

export default function Flow() {
  return (
    <Suspense fallback={<div className="loading">Loading diagram…</div>}>
      <FlowDiagram />
    </Suspense>
  );
}
