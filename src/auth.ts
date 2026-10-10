import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Pool } from "pg";

export const SESSION_COOKIE_NAME = "fssp_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type UserRole = "admin" | "editor" | "viewer";

export type AuthUser = {
  id: string;
  login: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  isActive: boolean;
};

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
    authSessionId?: string;
  }
}

export const normalizeLogin = (value: string) => value.trim().toLowerCase();

export const validatePassword = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 12 && value.length <= 200;

export const hashPassword = (password: string) =>
  argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });

export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);

export const createSessionToken = () => randomBytes(32).toString("base64url");

export const hashSessionToken = (token: string) => createHash("sha256").update(token).digest("hex");

const parseCookies = (header: string | undefined) => {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) {
      try {
        cookies.set(key, decodeURIComponent(value));
      } catch {
        cookies.set(key, value);
      }
    }
  }
  return cookies;
};

export const readSessionToken = (request: FastifyRequest) =>
  parseCookies(request.headers.cookie).get(SESSION_COOKIE_NAME);

const cookieOptions = () => {
  const secure = process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";
  return `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
};

export const setSessionCookie = (reply: FastifyReply, token: string) => {
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${SESSION_TTL_SECONDS}; ${cookieOptions()}`,
  );
};

export const clearSessionCookie = (reply: FastifyReply) => {
  reply.header("set-cookie", `${SESSION_COOKIE_NAME}=; Max-Age=0; ${cookieOptions()}`);
};

type SessionRow = {
  session_id: string;
  id: string;
  login: string;
  email: string | null;
  display_name: string;
  role: UserRole;
  is_active: boolean;
};

export const loadSession = async (pool: Pool, token: string) => {
  const result = await pool.query<SessionRow>(
    `
      SELECT
        s.id AS session_id,
        u.id,
        u.login,
        u.email,
        u.display_name,
        u.role,
        u.is_active
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.is_active = true
    `,
    [hashSessionToken(token)],
  );
  const row = result.rows[0];
  if (!row) return null;

  await pool.query("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [row.session_id]);
  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      login: row.login,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      isActive: row.is_active,
    } satisfies AuthUser,
  };
};

export const requireAuth = (pool: Pool | null): preHandlerHookHandler => async (request, reply) => {
  if (!pool) {
    return reply.code(503).send({ error: "database_unavailable" });
  }
  const token = readSessionToken(request);
  if (!token) {
    return reply.code(401).send({ error: "authentication_required" });
  }
  let session: Awaited<ReturnType<typeof loadSession>>;
  try {
    session = await loadSession(pool, token);
  } catch (error) {
    request.log.error(error);
    return reply.code(503).send({ error: "database_unavailable" });
  }
  if (!session) {
    clearSessionCookie(reply);
    return reply.code(401).send({ error: "authentication_required" });
  }
  request.authSessionId = session.sessionId;
  request.authUser = session.user;
};

export const requireRole = (pool: Pool | null, roles: UserRole[]): preHandlerHookHandler => {
  const authenticate = requireAuth(pool) as unknown as (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>;
  return async (request, reply) => {
    const result = await authenticate(request, reply);
    if (result !== undefined || reply.sent) return result;
    if (!request.authUser || !roles.includes(request.authUser.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
  };
};
