import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split SYNC deps into their own chunks so app changes don't bust
        // their cached versions on repeat visits.
        //
        // Heavy lazy deps (mermaid + cytoscape/d3/katex pulled in transitively
        // via FlowDiagram) are deliberately NOT named here — Vite issues
        // <link rel="modulepreload"> for every named chunk on initial load,
        // which would defeat the lazy import. Letting Rollup auto-chunk them
        // keeps them lazy.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("scheduler/")) return "react";
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("/zod/")) return "zod";
          // No `vendor` catch-all: forces remaining sync deps into the entry
          // chunk and lazy deps into Rollup's auto-generated lazy chunks.
        },
      },
    },
  },
});
