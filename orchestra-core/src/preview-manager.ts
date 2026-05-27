import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { create as tarCreate } from "tar";
import Docker from "dockerode";
import { eq, sql, and, lt } from "drizzle-orm";
import { simpleGit } from "simple-git";
import https from "node:https";
import { getDb, getPool } from "./db";
import { previewEnvs, projects } from "./db/schema";
import { decryptJson } from "./secrets";
import { detectPreviewSource, type DetectedSource } from "./preview-detect";
import { log } from "./obs";

/**
 * Per-project preview contour manager.
 *
 * See docs/PREVIEW_CONTOUR_DESIGN.md for the full design. v1 quick recap:
 *
 *   host docker.sock           ┌──────────────────────────┐
 *   ──────────────────────────►│ orchestra-core           │
 *   (USED HERE ONLY to spawn   │  • preview-manager.ts    │
 *   /destroy preview-dind-*    └──────────────┬───────────┘
 *   containers and the per-                   │ attached to
 *   project docker network)                   │ preview-net-<id>
 *                                              ▼
 *   plain TCP 2375 (v1.2)            ┌──────────────────────┐
 *   (TLS 2376 lands in v1.3)         │ preview-dind-<id>    │
 *   ───────────────────────────────► │  • docker:dind       │
 *                                    │  • runs preview-app  │
 *                                    └──────────────────────┘
 *
 * Multi-tenant invariant: the host docker.sock handle lives *exclusively*
 * inside this module — no exports, no re-exports. The only callers that
 * touch host docker are start/stop/inspect of the per-project DinD and
 * the per-project network. Agents have no docker CLI in the image and
 * cannot reach the sock either. Future code must not bypass this module
 * to talk to the host daemon — instead extend this manager.
 *
 * Build pipeline is host-side: simple-git checkout in the project's
 * existing worktree → tar stream → `docker build -` piped into the DinD.
 * Git credentials never enter the DinD; the DinD only ever sees a tarball.
 */

const HOST_DOCKER_SOCKET = process.env.PREVIEW_HOST_DOCKER_SOCKET ?? "/var/run/docker.sock";

const DIND_IMAGE = "docker:dind";
const DIND_TCP_PORT = 2375; // v1.3 switches to 2376 + TLS

const DEPLOY_HEALTH_TIMEOUT_MS = 60_000;
const WAKE_HEALTH_TIMEOUT_MS = 30_000;
const RECONCILE_INTERVAL_MS = 60_000;

let _hostDocker: Docker | null = null;
function hostDocker(): Docker {
  if (!_hostDocker) _hostDocker = new Docker({ socketPath: HOST_DOCKER_SOCKET });
  return _hostDocker;
}

function dindContainerName(projectId: string): string {
  return `preview-dind-${projectId}`;
}
function networkName(projectId: string): string {
  return `preview-net-${projectId}`;
}

/** dockerode client pointed at this project's DinD (plain TCP for v1.2). */
function dindClientFor(projectId: string): Docker {
  return new Docker({ host: dindContainerName(projectId), port: DIND_TCP_PORT, protocol: "http" });
}

/** Best-effort container/network lookup that swallows 404 from dockerode. */
async function tryInspect<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404) return null;
    throw err;
  }
}

// ─── DB helpers ────────────────────────────────────────────────────────────

interface PreviewEnvRow {
  id: string;
  projectId: string;
  enabled: boolean;
  dockerfilePath: string | null;
  composeFilePath: string | null;
  branch: string;
  appPort: number;
  envVarsEncrypted: string | null;
  idleTimeoutMinutes: number;
  state: string;
  currentCommit: string | null;
  errorMessage: string | null;
}

async function loadPreview(projectId: string): Promise<PreviewEnvRow | null> {
  const rows = await getDb().select().from(previewEnvs).where(eq(previewEnvs.projectId, projectId));
  return (rows[0] as PreviewEnvRow | undefined) ?? null;
}

async function updatePreviewState(
  projectId: string,
  patch: Partial<{
    state: string;
    currentCommit: string | null;
    lastDeployedAt: Date | null;
    errorMessage: string | null;
  }>,
): Promise<void> {
  await getDb()
    .update(previewEnvs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(previewEnvs.projectId, projectId));
}

function decryptEnvVars(blob: string | null): Record<string, string> {
  if (!blob) return {};
  try {
    return decryptJson<Record<string, string>>(blob);
  } catch (err) {
    log.error({ err }, "preview: failed to decrypt env_vars — falling back to empty");
    return {};
  }
}

// ─── Project worktree ──────────────────────────────────────────────────────

async function getProjectWorktree(projectId: string): Promise<string> {
  const rows = await getDb()
    .select({ localPath: projects.localPath })
    .from(projects)
    .where(eq(projects.id, projectId));
  const lp = rows[0]?.localPath;
  if (!lp) throw new Error(`preview: project ${projectId} has no localPath`);
  if (!fs.existsSync(lp)) throw new Error(`preview: project worktree missing at ${lp}`);
  return lp;
}

/** Fetch + checkout `branch` in the host worktree. Returns the resolved SHA. */
async function checkoutBranch(worktree: string, branch: string): Promise<string> {
  const git = simpleGit(worktree);
  await git.fetch("origin", branch);
  await git.checkout(branch);
  await git.pull("origin", branch).catch(() => { /* branch may be new; ignore */ });
  const sha = (await git.revparse(["HEAD"])).trim();
  return sha;
}

// ─── Host-side DinD lifecycle (uses host docker.sock) ──────────────────────

/**
 * Ensure the per-project DinD sidecar + network exist, and that
 * orchestra-core is attached to that network so it can resolve
 * `preview-dind-<id>` by name. Idempotent.
 */
export async function ensureDind(projectId: string): Promise<void> {
  const netName = networkName(projectId);
  const dindName = dindContainerName(projectId);
  const docker = hostDocker();

  // 1. Network
  const existingNets = await docker.listNetworks({ filters: { name: [netName] } });
  if (!existingNets.find((n) => n.Name === netName)) {
    await docker.createNetwork({ Name: netName, Driver: "bridge", Internal: false });
    log.info({ projectId, netName }, "preview: created docker network");
  }

  // 2. orchestra-core attaches to that network (idempotent)
  const selfId = process.env.PREVIEW_ORCHESTRA_CONTAINER ?? os.hostname();
  try {
    await docker.getNetwork(netName).connect({ Container: selfId });
  } catch (err) {
    const msg = (err as Error).message || "";
    // "already exists in network" → fine
    if (!/already exists|already attached/i.test(msg)) {
      log.warn({ err, projectId, selfId, netName }, "preview: orchestra-core network attach failed (continuing)");
    }
  }

  // 3. DinD container
  const existing = await tryInspect(docker.getContainer(dindName).inspect());
  if (!existing) {
    await docker.createContainer({
      name: dindName,
      Image: DIND_IMAGE,
      Cmd: ["--host=tcp://0.0.0.0:2375", "--tls=false"],
      Env: ["DOCKER_TLS_CERTDIR="], // disable auto-TLS generation; v1.3 adds proper TLS
      HostConfig: {
        Privileged: true,
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: netName,
      },
      NetworkingConfig: { EndpointsConfig: { [netName]: {} } },
    });
    log.info({ projectId, dindName }, "preview: created DinD container");
  }
  const state = (await docker.getContainer(dindName).inspect()).State;
  if (!state.Running) {
    await docker.getContainer(dindName).start();
    log.info({ projectId, dindName }, "preview: started DinD container");
    // Give the daemon a moment to open the TCP port.
    await sleep(2000);
  }
}

/** Stop and remove the DinD + network. Called on teardown. */
export async function destroyDind(projectId: string): Promise<void> {
  const docker = hostDocker();
  const dindName = dindContainerName(projectId);
  const netName = networkName(projectId);

  const c = docker.getContainer(dindName);
  const existing = await tryInspect(c.inspect());
  if (existing) {
    await c.remove({ force: true });
    log.info({ projectId, dindName }, "preview: removed DinD container");
  }

  const nets = await docker.listNetworks({ filters: { name: [netName] } });
  if (nets.find((n) => n.Name === netName)) {
    try {
      await docker.getNetwork(netName).remove();
      log.info({ projectId, netName }, "preview: removed docker network");
    } catch (err) {
      log.warn({ err, projectId, netName }, "preview: network remove failed (probably still has endpoints)");
    }
  }
}

// ─── App lifecycle (uses per-project DinD) ─────────────────────────────────
//
// v1.9: unified deploy via `docker compose up -d --build` inside DinD.
// For projects with no compose file we synthesize a one-service compose
// from the detected Dockerfile, so there's a single deploy path.

const DIND_PROJECT_DIR = "/preview-src";
const COMPOSE_PROJECT_NAME = "preview";

interface DeployPlan {
  source: DetectedSource;
  composeFileInsideDind: string; // absolute path inside DinD
  contextPathInsideDind: string;
}

/**
 * Decide what to build/run for a project. User-provided fields win over
 * auto-detection; auto-detection runs only when both dockerfilePath and
 * composeFilePath are absent. The detected/used values are persisted back
 * to the row so subsequent stop/wake/teardown calls don't need to re-scan.
 */
async function planDeploy(row: PreviewEnvRow, worktree: string): Promise<DeployPlan> {
  let source: DetectedSource;
  if (row.composeFilePath) {
    const dir = path.dirname(row.composeFilePath) === "." ? "" : path.dirname(row.composeFilePath);
    source = {
      kind: "compose",
      contextPath: dir,
      filePath: path.basename(row.composeFilePath),
      appPort: row.appPort || 8080,
      appProtocol: protocolForPort(row.appPort || 8080),
      service: "app",
    };
  } else if (row.dockerfilePath) {
    const dir = path.dirname(row.dockerfilePath) === "." ? "" : path.dirname(row.dockerfilePath);
    source = {
      kind: "dockerfile",
      contextPath: dir,
      filePath: path.basename(row.dockerfilePath),
      appPort: row.appPort || 8080,
      appProtocol: protocolForPort(row.appPort || 8080),
    };
  } else {
    source = detectPreviewSource(worktree);
    // Persist detected values so stop/wake don't have to re-scan, and the
    // UI shows the user what we picked.
    await getDb().update(previewEnvs).set({
      composeFilePath: source.kind === "compose" ? path.join(source.contextPath, source.filePath) : null,
      dockerfilePath: source.kind === "dockerfile" ? path.join(source.contextPath, source.filePath) : null,
      appPort: source.appPort,
      updatedAt: new Date(),
    }).where(eq(previewEnvs.projectId, row.projectId));
    log.info({ projectId: row.projectId, source }, "preview: auto-detected source");
  }

  // For dockerfile-only projects we synthesize a tiny compose at deploy
  // time and use the same flow — gives us one deploy path.
  const composeFileInsideDind =
    source.kind === "compose"
      ? `${DIND_PROJECT_DIR}/${source.contextPath ? source.contextPath + "/" : ""}${source.filePath}`
      : `${DIND_PROJECT_DIR}/.orchestra-preview-compose.yaml`;
  const contextPathInsideDind = `${DIND_PROJECT_DIR}${source.contextPath ? "/" + source.contextPath : ""}`;
  return { source, composeFileInsideDind, contextPathInsideDind };
}

/**
 * Synthesize a minimal compose for the single-Dockerfile case. One
 * service named `app`, builds the user's Dockerfile, publishes the
 * detected port.
 */
function synthesizeCompose(source: Extract<DetectedSource, { kind: "dockerfile" }>, envBag: Record<string, string>): string {
  const envLines = Object.keys(envBag).length
    ? "    environment:\n" + Object.keys(envBag).map((k) => `      ${k}: \${${k}}`).join("\n") + "\n"
    : "";
  return [
    "services:",
    "  app:",
    "    build:",
    `      context: .`,
    `      dockerfile: ${source.filePath}`,
    `    ports:`,
    `      - "${source.appPort}:${source.appPort}"`,
    envLines,
    "    restart: unless-stopped",
    "",
  ].join("\n");
}

/** Pull branch, ship source into DinD, run `docker compose up -d --build`. */
export async function deploy(projectId: string, overrideBranch?: string): Promise<void> {
  const row = await loadPreview(projectId);
  if (!row) throw new Error(`preview: no config for project ${projectId}`);
  if (!row.enabled) throw new Error("preview: not enabled for this project");

  const branch = overrideBranch ?? row.branch;
  const worktree = await getProjectWorktree(projectId);

  await ensureDind(projectId);
  await updatePreviewState(projectId, { state: "building", errorMessage: null });

  try {
    const sha = await checkoutBranch(worktree, branch);
    const plan = await planDeploy(await loadPreview(projectId) ?? row, worktree);
    const envBag = decryptEnvVars(row.envVarsEncrypted);
    const dind = dindClientFor(projectId);

    // 1. Wipe any previous /preview-src and re-create.
    await execInDind(dind, `rm -rf ${DIND_PROJECT_DIR} && mkdir -p ${DIND_PROJECT_DIR}`);

    // 2. tar worktree → putArchive into DinD root container at DIND_PROJECT_DIR.
    //    Use a sidecar "ferry" container running a simple shell so we can
    //    call putArchive on it — DinD's own filesystem is the docker
    //    daemon's data root, not where compose will read from.
    //
    //    Actually, the DinD container IS the host for the inner daemon —
    //    and docker compose reads its compose file from the DinD container's
    //    filesystem. So we putArchive directly to the DinD container.
    const tarStream = tarCreate(
      { cwd: worktree, gzip: false, portable: true, follow: false },
      await listWorktreeEntries(worktree),
    ) as unknown as Readable;

    const docker = hostDocker();
    await docker.getContainer(dindContainerName(projectId)).putArchive(tarStream, { path: DIND_PROJECT_DIR });

    // 3. If single Dockerfile, write a synthesized compose file alongside.
    if (plan.source.kind === "dockerfile") {
      const composeYaml = synthesizeCompose(plan.source, envBag);
      await execInDind(
        dind,
        `cat > ${plan.composeFileInsideDind} <<'YAML_EOF'\n${composeYaml}\nYAML_EOF`,
      );
    }

    // 4. Build env-var prefix for the compose-up so `${VAR}` interpolation
    //    works without leaving plaintext on the DinD filesystem.
    const envPrefix = Object.entries(envBag)
      .map(([k, v]) => `${shellQuote(k)}=${shellQuote(v)}`)
      .join(" ");

    // 5. compose up -d --build. Long timeout — image builds can take minutes.
    await execInDind(
      dind,
      `cd ${plan.contextPathInsideDind} && ${envPrefix ? envPrefix + " " : ""}docker compose -p ${COMPOSE_PROJECT_NAME} -f ${plan.composeFileInsideDind} up -d --build`,
      { timeoutMs: 10 * 60_000 },
    );

    // 6. Wait for app health.
    await waitForAppHealthy(projectId, plan.source.appPort, plan.source.appProtocol, DEPLOY_HEALTH_TIMEOUT_MS);

    await updatePreviewState(projectId, {
      state: "running",
      currentCommit: sha,
      lastDeployedAt: new Date(),
      errorMessage: null,
    });
    log.info({ projectId, sha, branch, source: plan.source }, "preview: deployed");
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await updatePreviewState(projectId, { state: "error", errorMessage: message });
    log.error({ err, projectId }, "preview: deploy failed");
    throw err;
  }
}

/** docker compose stop — keeps containers around for fast wake. */
export async function stop(projectId: string): Promise<void> {
  const row = await loadPreview(projectId);
  if (!row) return;
  try {
    const dind = dindClientFor(projectId);
    const plan = await planDeploy(row, await getProjectWorktree(projectId));
    await execInDind(
      dind,
      `cd ${plan.contextPathInsideDind} && docker compose -p ${COMPOSE_PROJECT_NAME} -f ${plan.composeFileInsideDind} stop`,
      { timeoutMs: 60_000, ignoreExitNonzero: true },
    );
  } catch (err) {
    log.warn({ err, projectId }, "preview: stop failed");
  }
  await updatePreviewState(projectId, { state: "sleeping" });
}

/** docker compose start — re-enables existing containers. */
export async function wake(projectId: string): Promise<void> {
  const row = await loadPreview(projectId);
  if (!row) throw new Error(`preview: no config for project ${projectId}`);
  await ensureDind(projectId);

  const worktree = await getProjectWorktree(projectId);
  const plan = await planDeploy(row, worktree);
  const dind = dindClientFor(projectId);

  // If the compose project's containers don't exist, run a full deploy.
  const listOut = await execInDind(
    dind,
    `docker compose -p ${COMPOSE_PROJECT_NAME} -f ${plan.composeFileInsideDind} ps -q`,
    { ignoreExitNonzero: true },
  );
  if (!listOut.trim()) {
    await deploy(projectId);
    return;
  }

  await execInDind(
    dind,
    `cd ${plan.contextPathInsideDind} && docker compose -p ${COMPOSE_PROJECT_NAME} -f ${plan.composeFileInsideDind} start`,
    { timeoutMs: 60_000 },
  );
  await waitForAppHealthy(projectId, plan.source.appPort, plan.source.appProtocol, WAKE_HEALTH_TIMEOUT_MS);
  await updatePreviewState(projectId, { state: "running", errorMessage: null });
}

/** docker compose down -v + remove DinD + network. */
export async function teardown(projectId: string): Promise<void> {
  try {
    const row = await loadPreview(projectId);
    if (row) {
      const dind = dindClientFor(projectId);
      const worktree = await getProjectWorktree(projectId).catch(() => null);
      if (worktree) {
        const plan = await planDeploy(row, worktree).catch(() => null);
        if (plan) {
          await execInDind(
            dind,
            `cd ${plan.contextPathInsideDind} && docker compose -p ${COMPOSE_PROJECT_NAME} -f ${plan.composeFileInsideDind} down -v`,
            { timeoutMs: 60_000, ignoreExitNonzero: true },
          );
        }
      }
    }
  } catch (err) {
    log.warn({ err, projectId }, "preview: teardown compose-down failed (ignoring)");
  }
  await destroyDind(projectId);
  await updatePreviewState(projectId, { state: "stopped", currentCommit: null, errorMessage: null });
}

// ─── DinD exec helper ──────────────────────────────────────────────────────

interface ExecOpts {
  timeoutMs?: number;
  ignoreExitNonzero?: boolean;
}

/**
 * Run a shell command inside this project's DinD container via dockerode's
 * exec API. Captures stdout+stderr for surfacing in error messages and the
 * /logs endpoint. NOT using `dind.run` because we want to attach to an
 * existing privileged container.
 */
async function execInDind(dind: Docker, cmd: string, opts: ExecOpts = {}): Promise<string> {
  // The DinD container hosts the docker daemon; we need to exec INSIDE it.
  // dind dockerode client is pointed at its TCP socket — which is the
  // inner daemon, not the DinD container itself. So we go through the
  // host docker to get a container handle, then exec.
  const docker = hostDocker();
  const projectId = extractProjectIdFromDindClient(dind);
  const container = docker.getContainer(dindContainerName(projectId));

  const exec = await container.exec({
    Cmd: ["sh", "-c", cmd],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ Detach: false });

  const chunks: Buffer[] = [];
  const collected = new Promise<void>((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  const timer = opts.timeoutMs
    ? setTimeout(() => stream.destroy(new Error(`execInDind timeout after ${opts.timeoutMs}ms`)), opts.timeoutMs)
    : null;
  try {
    await collected;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const info = await exec.inspect();
  const out = Buffer.concat(chunks).toString("utf-8");
  if (info.ExitCode !== 0 && !opts.ignoreExitNonzero) {
    throw new Error(`execInDind exit ${info.ExitCode}: ${out.slice(-500)}`);
  }
  return out;
}

/**
 * Recover the project id from a per-project DinD client. The host field
 * encodes it (`preview-dind-<projectId>`). Cheap and avoids passing
 * projectId through every helper signature.
 */
function extractProjectIdFromDindClient(dind: Docker): string {
  const host = (dind as unknown as { modem: { host?: string } }).modem.host ?? "";
  return host.replace(/^preview-dind-/, "");
}

function protocolForPort(port: number): "http" | "https" {
  return port === 443 || port === 8443 ? "https" : "http";
}

function shellQuote(s: string): string {
  // POSIX single-quote everything; escape any embedded single quotes.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── Health probe ──────────────────────────────────────────────────────────

async function waitForAppHealthy(
  projectId: string,
  port: number,
  protocol: "http" | "https",
  timeoutMs: number,
): Promise<void> {
  const url = `${protocol}://${dindContainerName(projectId)}:${port}/`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchInsecureIfHttps(url, 2000);
      // Any 2xx/3xx/4xx is "responding". 5xx + connection errors keep waiting.
      if (res.status < 500) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(1500);
  }
  throw new Error(`preview: app at ${url} did not become healthy: ${(lastErr as Error)?.message ?? "timeout"}`);
}

/**
 * fetch() with self-signed-cert tolerance when the URL is https. Node's
 * default fetch enforces TLS verification; preview projects routinely
 * front themselves with caddy `tls internal` or self-signed certs.
 */
async function fetchInsecureIfHttps(url: string, timeoutMs: number): Promise<{ status: number }> {
  if (!url.startsWith("https:")) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status };
  }
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "HEAD", rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

// ─── Worktree → tar entries ────────────────────────────────────────────────

async function listWorktreeEntries(worktree: string): Promise<string[]> {
  // Ship the entire repo contents except node_modules / .git. Simple and
  // adequate for v1; v2 can honor a `.dockerignore` if present.
  const entries = fs.readdirSync(worktree);
  return entries.filter((e) => e !== ".git" && e !== "node_modules");
}

// ─── Reconcile / idle-sweep loop ───────────────────────────────────────────

let reconcileTimer: NodeJS.Timeout | null = null;

async function reconcile(): Promise<void> {
  // Enabled previews → ensure DinD up
  const enabled = await getDb()
    .select({ projectId: previewEnvs.projectId })
    .from(previewEnvs)
    .where(eq(previewEnvs.enabled, true));
  for (const { projectId } of enabled) {
    try {
      await ensureDind(projectId);
    } catch (err) {
      log.warn({ err, projectId }, "preview: ensureDind in reconcile failed");
    }
  }

  // Idle-sweep: running, last_request_at < now() - idle_timeout
  // Use raw SQL for the interval comparison since drizzle doesn't have a
  // first-class way to express `now() - (col || ' minutes')::interval`.
  const pool = getPool();
  const { rows } = await pool.query<{ project_id: string }>(
    `SELECT project_id FROM preview_envs
     WHERE enabled = true
       AND state = 'running'
       AND last_request_at IS NOT NULL
       AND last_request_at < now() - (idle_timeout_minutes || ' minutes')::interval`,
  );
  for (const r of rows) {
    try {
      log.info({ projectId: r.project_id }, "preview: idle sweep → sleeping");
      await stop(r.project_id);
    } catch (err) {
      log.warn({ err, projectId: r.project_id }, "preview: idle-sweep stop failed");
    }
  }
}

// Suppress unused-import warning when drizzle-orm helpers aren't all used.
void and; void lt; void sql;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startPreviewManager(): Promise<void> {
  await reconcile().catch((err) => log.error({ err }, "preview: initial reconcile failed"));
  reconcileTimer = setInterval(() => {
    reconcile().catch((err) => log.error({ err }, "preview: reconcile failed"));
  }, RECONCILE_INTERVAL_MS);
}

export function stopPreviewManager(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
}

/** Bump last_request_at when a preview is hit. Throttled by callers via cache. */
export async function touchLastRequest(projectId: string): Promise<void> {
  await getDb()
    .update(previewEnvs)
    .set({ lastRequestAt: new Date() })
    .where(eq(previewEnvs.projectId, projectId));
}

/**
 * Tail combined logs across all compose services for this project's
 * preview. Returns up to `tail` lines per service, interleaved by the
 * `docker compose logs` timestamps.
 */
export async function fetchPreviewLogsCombined(projectId: string, tail: number): Promise<string[]> {
  const row = await loadPreview(projectId);
  if (!row) return [];
  const worktree = await getProjectWorktree(projectId).catch(() => null);
  if (!worktree) return [];
  const plan = await planDeploy(row, worktree);
  const dind = dindClientFor(projectId);
  try {
    const out = await execInDind(
      dind,
      `docker compose -p ${COMPOSE_PROJECT_NAME} -f ${plan.composeFileInsideDind} logs --no-color --timestamps --tail ${tail}`,
      { timeoutMs: 15_000, ignoreExitNonzero: true },
    );
    return out.split("\n").filter((l) => l.length > 0);
  } catch (err) {
    return [`(не удалось прочитать compose logs: ${(err as Error).message})`];
  }
}
