import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/**
 * Auto-detect how a project wants to be run for preview.
 *
 * See docs/PREVIEW_CONTOUR_DESIGN.md. The goal is that a user enabling
 * preview should NOT have to spell out where the Dockerfile / compose
 * file lives or which port to publish — orchestra discovers it from the
 * repo. For projects with multiple Dockerfiles or composes, the
 * convention is "deepest match in a well-known directory wins".
 *
 * Output is intentionally minimal: callers decide what to do with it.
 */

export type DetectedSource =
  | {
      kind: "compose";
      contextPath: string;  // relative dir, e.g. "buildable"
      filePath: string;     // basename, e.g. "docker-compose.yaml"
      appPort: number;      // publicly-mapped port to expose
      appProtocol: "http" | "https";
      service: string;      // service whose port we picked
    }
  | {
      kind: "dockerfile";
      contextPath: string;
      filePath: string;
      appPort: number;
      appProtocol: "http" | "https";
    };

/**
 * Search order: project root, then common sub-dirs. First hit wins.
 * Compose is preferred over Dockerfile-only because it usually means
 * the project has its own multi-container topology already wired up.
 */
const SEARCH_DIRS = ["", "buildable", "docker", "deploy", "compose", "infra"];
const COMPOSE_NAMES = ["docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"];
const DOCKERFILE_NAMES = ["Dockerfile"];

export function detectPreviewSource(worktree: string): DetectedSource {
  // Pass 1: any compose file in any well-known dir
  for (const dir of SEARCH_DIRS) {
    for (const name of COMPOSE_NAMES) {
      const rel = dir ? path.join(dir, name) : name;
      const abs = path.join(worktree, rel);
      if (!fs.existsSync(abs)) continue;
      const det = parseCompose(abs, dir);
      if (det) return det;
    }
  }
  // Pass 2: any Dockerfile in any well-known dir
  for (const dir of SEARCH_DIRS) {
    for (const name of DOCKERFILE_NAMES) {
      const rel = dir ? path.join(dir, name) : name;
      const abs = path.join(worktree, rel);
      if (!fs.existsSync(abs)) continue;
      const exposed = parseDockerfileExpose(abs);
      return {
        kind: "dockerfile",
        contextPath: dir,
        filePath: name,
        appPort: exposed ?? 8080,
        appProtocol: "http",
      };
    }
  }
  throw new Error(
    "preview: no Dockerfile or docker-compose file found. " +
      "Looked in: " + SEARCH_DIRS.map((d) => d || "(root)").join(", "),
  );
}

interface ComposeService {
  ports?: (string | { published?: string | number; target?: string | number; protocol?: string })[];
  image?: string;
  build?: unknown;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
}

function parseCompose(abs: string, contextPath: string): DetectedSource | null {
  let doc: ComposeFile;
  try {
    doc = YAML.parse(fs.readFileSync(abs, "utf-8")) as ComposeFile;
  } catch {
    return null;
  }
  if (!doc?.services) return null;

  // Pick the first service that publishes a port. Prefer services whose
  // name hints at a public entry point (proxy / gateway / web / app / nginx /
  // caddy / traefik) — those are more likely the user-facing surface than
  // an internal service that just happens to publish a debug port.
  const priorityHints = /^(proxy|gateway|web|app|nginx|caddy|traefik|envoy|ingress|api)$/i;
  const services = Object.entries(doc.services);
  const ordered = [
    ...services.filter(([n]) => priorityHints.test(n)),
    ...services.filter(([n]) => !priorityHints.test(n)),
  ];

  for (const [name, svc] of ordered) {
    const port = pickPublicPort(svc);
    if (!port) continue;
    return {
      kind: "compose",
      contextPath,
      filePath: path.basename(abs),
      appPort: port,
      appProtocol: guessProtocol(name, svc, port),
      service: name,
    };
  }
  return null;
}

/**
 * Extract a "publicly mapped" port from a compose `ports:` directive.
 * Compose accepts several syntaxes:
 *   - "8080"           → both host and container 8080
 *   - "8080:8080"      → host:container
 *   - "127.0.0.1:8080:8080"
 *   - { published: 8080, target: 8080 }
 *
 * We want the host-side port (= what'll be reachable inside the DinD
 * from orchestra-core). When the host port is undefined, fall back to
 * the container port.
 */
function pickPublicPort(svc: ComposeService): number | null {
  if (!svc.ports) return null;
  for (const p of svc.ports) {
    const port = portFromEntry(p);
    if (port) return port;
  }
  return null;
}

function portFromEntry(p: string | { published?: string | number; target?: string | number; protocol?: string }): number | null {
  if (typeof p === "string") {
    // Trim "tcp"/"udp" suffix and strip the host IP prefix.
    const core = p.split("/")[0]!;
    const parts = core.split(":");
    // The host-side port is the second-to-last component.
    // "8080"               → ["8080"]                    → 8080
    // "8080:8080"          → ["8080","8080"]             → 8080
    // "127.0.0.1:8080:80"  → ["127.0.0.1","8080","80"]   → 8080
    const hostSide = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    const n = parseInt(hostSide!, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (typeof p === "object" && p) {
    const v = p.published ?? p.target;
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Guess HTTP vs HTTPS. Self-signed-cert proxies (caddy with `tls
 * internal`, traefik, envoy) commonly serve HTTPS on user-visible
 * ports. Heuristic:
 *   - service name matches a proxy hint AND port == 443/8443 → https
 *   - port == 443 or 8443 → https (regardless of service name)
 *   - everything else → http
 */
function guessProtocol(serviceName: string, _svc: ComposeService, port: number): "http" | "https" {
  if (port === 443 || port === 8443) return "https";
  // Some projects publish a non-standard HTTPS port — treat by name.
  if (/(?:caddy|traefik|nginx-ssl|tls)/i.test(serviceName) && port !== 80) return "https";
  return "http";
}

function parseDockerfileExpose(abs: string): number | null {
  try {
    const src = fs.readFileSync(abs, "utf-8");
    for (const raw of src.split("\n")) {
      const line = raw.trim();
      if (!/^EXPOSE\s/i.test(line)) continue;
      const tokens = line.split(/\s+/).slice(1);
      for (const t of tokens) {
        const n = parseInt(t.split("/")[0]!, 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
