import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { create as tarCreate } from "tar";
import Docker from "dockerode";
import { eq, sql, and, lt } from "drizzle-orm";
import { simpleGit } from "simple-git";
import { getDb, getPool } from "./db";
import { previewEnvs, projects } from "./db/schema";
import { decryptJson } from "./secrets";
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

// ─── App container lifecycle (uses per-project DinD) ───────────────────────

const APP_CONTAINER = "preview-app";
const APP_IMAGE_TAG = "preview-app:latest";

/**
 * Pull the configured branch, tar the worktree, build the image inside
 * the DinD, and (re)start the app container. Blocks until healthy.
 */
export async function deploy(projectId: string, overrideBranch?: string): Promise<void> {
  const row = await loadPreview(projectId);
  if (!row) throw new Error(`preview: no config for project ${projectId}`);
  if (!row.enabled) throw new Error("preview: not enabled for this project");
  if (!row.dockerfilePath) throw new Error("preview: dockerfile_path is required");

  const branch = overrideBranch ?? row.branch;
  const worktree = await getProjectWorktree(projectId);

  await ensureDind(projectId);
  await updatePreviewState(projectId, { state: "building", errorMessage: null });

  try {
    const sha = await checkoutBranch(worktree, branch);

    const tarStream = tarCreate(
      { cwd: worktree, gzip: false, portable: true, follow: false },
      await listWorktreeEntries(worktree),
    ) as unknown as Readable;

    const dind = dindClientFor(projectId);
    const buildStream = await dind.buildImage(tarStream, {
      t: APP_IMAGE_TAG,
      dockerfile: row.dockerfilePath,
      // BuildKit produces incompatible streaming JSON for `followProgress`,
      // so stay on the legacy builder for v1.
      buildargs: {},
    });

    await new Promise<void>((resolve, reject) => {
      dind.modem.followProgress(
        buildStream as NodeJS.ReadableStream,
        (err, output) => {
          if (err) return reject(err);
          const lastErr = output?.find((o) => (o as { error?: string }).error);
          if (lastErr) return reject(new Error((lastErr as { error: string }).error));
          resolve();
        },
        () => { /* per-line; ignore for now */ },
      );
    });

    // Replace any prior app container
    const existingApp = await tryInspect(dind.getContainer(APP_CONTAINER).inspect());
    if (existingApp) await dind.getContainer(APP_CONTAINER).remove({ force: true });

    const envBag = decryptEnvVars(row.envVarsEncrypted);
    const envList = Object.entries(envBag).map(([k, v]) => `${k}=${v}`);
    envList.push(`PORT=${row.appPort}`);

    const portKey = `${row.appPort}/tcp`;
    const container = await dind.createContainer({
      name: APP_CONTAINER,
      Image: APP_IMAGE_TAG,
      Env: envList,
      ExposedPorts: { [portKey]: {} },
      HostConfig: {
        RestartPolicy: { Name: "unless-stopped" },
      },
    });
    await container.start();

    await waitForAppHealthy(projectId, row.appPort, DEPLOY_HEALTH_TIMEOUT_MS);

    await updatePreviewState(projectId, {
      state: "running",
      currentCommit: sha,
      lastDeployedAt: new Date(),
      errorMessage: null,
    });
    log.info({ projectId, sha, branch }, "preview: deployed");
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await updatePreviewState(projectId, { state: "error", errorMessage: message });
    log.error({ err, projectId }, "preview: deploy failed");
    throw err;
  }
}

/** Stop the app container; DinD stays warm. */
export async function stop(projectId: string): Promise<void> {
  const dind = dindClientFor(projectId);
  const c = dind.getContainer(APP_CONTAINER);
  const existing = await tryInspect(c.inspect());
  if (existing && existing.State.Running) await c.stop({ t: 10 });
  await updatePreviewState(projectId, { state: "sleeping" });
}

/** Start the app container if sleeping. Blocks until healthy. */
export async function wake(projectId: string): Promise<void> {
  const row = await loadPreview(projectId);
  if (!row) throw new Error(`preview: no config for project ${projectId}`);
  await ensureDind(projectId);
  const dind = dindClientFor(projectId);
  const c = dind.getContainer(APP_CONTAINER);
  const existing = await tryInspect(c.inspect());
  if (!existing) {
    // Nothing built yet — fall through to a deploy.
    await deploy(projectId);
    return;
  }
  if (!existing.State.Running) await c.start();
  await waitForAppHealthy(projectId, row.appPort, WAKE_HEALTH_TIMEOUT_MS);
  await updatePreviewState(projectId, { state: "running", errorMessage: null });
}

/** Stop + remove app, DinD, and network. Clears runtime fields. */
export async function teardown(projectId: string): Promise<void> {
  try {
    const dind = dindClientFor(projectId);
    const c = dind.getContainer(APP_CONTAINER);
    if (await tryInspect(c.inspect())) await c.remove({ force: true });
  } catch (err) {
    log.warn({ err, projectId }, "preview: teardown app-container removal failed (ignoring)");
  }
  await destroyDind(projectId);
  await updatePreviewState(projectId, { state: "stopped", currentCommit: null, errorMessage: null });
}

// ─── Health probe ──────────────────────────────────────────────────────────

async function waitForAppHealthy(projectId: string, port: number, timeoutMs: number): Promise<void> {
  const url = `http://${dindContainerName(projectId)}:${port}/`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
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
