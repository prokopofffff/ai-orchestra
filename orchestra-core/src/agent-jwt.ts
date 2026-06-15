import { getPool } from "./db";

/**
 * Per-spawn JWT for MCP tool calls.
 *
 * The HTTP preHandler in index.ts requires a JWT on every /api/* route, but
 * agent runs are server-side calls from a child MCP-tool process — they
 * have no user session. To let agents hit task / signal / pr APIs through
 * the same auth path as a logged-in user, we mint a short-lived JWT for
 * the project's owner before spawning, pass it via env, and the MCP tool
 * sends it as `Authorization: Bearer …`.
 *
 * Why "owner" and not a synthetic agent user: the API's project-access
 * gates (`userCanEditProject`) check ownership/membership. Acting as the
 * owner means we don't need a parallel "agent has access" code path —
 * the existing user-permission checks all just pass.
 */
type AgentClaims = {
  id: string;
  email: string;
  username: string;
  kind: "agent";
  role: string;
  projectId: string;
};
type SignerFn = (payload: AgentClaims, opts?: { expiresIn: string }) => string;

let signer: SignerFn | null = null;

// Agent runs are bounded (a single dispatch turn, minutes not hours). A 12h
// TTL gives generous slack while ensuring a leaked agent token can't be
// replayed indefinitely — the original tokens never expired at all.
const AGENT_JWT_TTL = "12h";

/**
 * Wire up the signer. Called once from index.ts after `fastifyJwt` registers
 * — `app.jwt.sign` is the same function `reply.jwtSign` delegates to, so
 * tokens minted here verify identically against the same secret.
 */
export function setAgentJwtSigner(fn: SignerFn): void {
  signer = fn;
}

/**
 * Mint a JWT impersonating the project's owner. Throws if the project has
 * no owner — that's a misconfiguration the spawner should surface as a
 * preflight error rather than silently issuing a token nobody can attribute
 * actions to.
 */
export async function mintAgentJwt(projectId: string, role: string): Promise<string> {
  if (!signer) throw new Error("agent-jwt signer not initialized — call setAgentJwtSigner() at startup");

  const { rows } = await getPool().query<{ id: string; email: string; username: string }>(
    `SELECT u.id, u.email, u.username
       FROM users u
       JOIN projects p ON p.owner_id = u.id
      WHERE p.id = $1
      LIMIT 1`,
    [projectId],
  );
  if (!rows.length) {
    throw new Error(`Cannot mint agent JWT: project ${projectId} has no owner`);
  }
  return signer(
    {
      id: rows[0].id,
      email: rows[0].email,
      username: rows[0].username,
      kind: "agent",
      role,
      projectId,
    },
    { expiresIn: AGENT_JWT_TTL },
  );
}
