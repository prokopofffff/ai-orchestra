import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Allow non-localhost hosts when Vite runs inside Docker — without
    // this Vite 5 blocks requests whose Host header isn't allowlisted.
    host: true,
    proxy: {
      // VITE_API_PROXY lets docker-compose.dev.yml point Vite at the
      // orchestra-core service over the docker network. Falls back to
      // localhost:3000 for the host-tsx ("legacy") dev path.
      "/api": process.env.VITE_API_PROXY ?? "http://localhost:3000",
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
          if (id.includes("react-router")) return "router";
          if (id.includes("/zod/")) return "zod";
          // No `vendor` catch-all: forces remaining sync deps into the entry
          // chunk and lazy deps into Rollup's auto-generated lazy chunks.
        },
      },
    },
  },
});
