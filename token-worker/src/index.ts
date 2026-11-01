/**
 * Serves short-lived Codex access tokens from one ChatGPT login.
 *
 * The scheduled handler is the only code that refreshes the login:
 * a refresh rotates the refresh token, so a second refresher
 * would spend it. Clients receive the access token alone.
 */

import type {
  ExecutionContext,
  ScheduledController,
} from "@cloudflare/workers-types";

import {
  accessTokenExpiryMs,
  isRecord,
  openBundle,
  sealBundle,
} from "./bundle";
import type { StoredLogin } from "./bundle";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const HOUR_MS = 60 * 60 * 1000;

// The cron runs every 6 hours, so a refresh that keeps failing still
// leaves more than a day of valid access before clients notice.
const REFRESH_BELOW_MS = 36 * HOUR_MS;

// Clients fetch a new token once theirs has less than an hour left,
// so a token closer to expiry than that is never served.
const SERVE_ABOVE_MS = HOUR_MS;

const KV_PUT_ATTEMPTS = 3;

export const BUNDLE_KV_KEY = "bundle";
export const STATUS_KV_KEY = "status";

const SEED_HINT =
  "Run `bun token-worker/scripts/seed.ts` to store a fresh login.";

/**
 * The part of the CODEX_AUTH KV namespace the worker uses, so tests can pass
 * an in-memory map. A type test proves a real KVNamespace fits it.
 */
export interface LoginStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** The bindings wrangler.jsonc declares, and the worker's secrets. */
export interface WorkerEnv {
  CODEX_AUTH: LoginStore;
  SERVE_TOKEN?: string | undefined;
  BUNDLE_KEY?: string | undefined;
}

export type RefreshOutcome =
  | { refreshed: true }
  | { refreshed: false; reason: string };

interface RefreshResponse {
  access_token: string;
  id_token?: unknown;
  refresh_token?: unknown;
}

export default {
  fetch: (request: Request, env: WorkerEnv): Promise<Response> =>
    handleRequest(request, env),
  scheduled: (
    _controller: ScheduledController,
    env: WorkerEnv,
    context: Pick<ExecutionContext, "waitUntil">,
  ): void => context.waitUntil(refreshIfExpiring(env)),
};

export async function handleRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname !== "/auth.json" && pathname !== "/status") {
    return json(
      { error: `Unknown path ${pathname}. Use /auth.json or /status.` },
      404,
    );
  }

  if (request.method !== "GET") {
    return json({ error: `${request.method} is not supported. Use GET.` }, 405);
  }

  if (!env.SERVE_TOKEN) {
    return json(
      { error: "The SERVE_TOKEN secret is not set on the worker." },
      500,
    );
  }

  if (!(await hasServeToken(request, env.SERVE_TOKEN))) {
    return json(
      {
        error:
          "Missing or invalid serve token. Send it as 'Authorization: Bearer <serve token>'.",
      },
      401,
    );
  }

  let login: StoredLogin | null;

  try {
    login = await loadLogin(env);
  } catch (error) {
    return json(
      {
        error: `Unable to open the stored login: ${errorMessage(error)} ${SEED_HINT}`,
      },
      503,
    );
  }

  if (!login) {
    return json({ error: `No Codex login is stored. ${SEED_HINT}` }, 503);
  }

  const expiresAt = accessTokenExpiryMs(login.tokens.access_token);

  if (pathname === "/status") {
    return json({
      access_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      last_refresh: login.last_refresh ?? null,
      ...(await loadStatus(env)),
    });
  }

  if (!expiresAt) {
    return json(
      { error: `The stored access token has no readable expiry. ${SEED_HINT}` },
      503,
    );
  }

  if (expiresAt - Date.now() < SERVE_ABOVE_MS) {
    const { last_error: lastError } = await loadStatus(env);
    const cause = lastError
      ? ` The last refresh failed: ${asText(lastError)}`
      : "";

    return json(
      {
        error: `The stored access token has less than an hour left.${cause} ${SEED_HINT}`,
      },
      503,
    );
  }

  return json(clientLogin(login));
}

/**
 * Refreshes the stored login once its access token has less
 * than REFRESH_BELOW_MS left. A failure leaves the stored
 * login intact.
 */
export async function refreshIfExpiring(
  env: WorkerEnv,
  now = Date.now(),
): Promise<RefreshOutcome> {
  const login = await loadLogin(env);

  if (!login) {
    return { refreshed: false, reason: "no login stored" };
  }

  // A token with no readable expiry counts as expired.
  const expiresAt = accessTokenExpiryMs(login.tokens.access_token) ?? 0;

  if (expiresAt - now > REFRESH_BELOW_MS) {
    return { refreshed: false, reason: "access token still fresh" };
  }

  const attemptedAt = new Date(now).toISOString();
  let refreshedLogin: StoredLogin;

  try {
    refreshedLogin = withRefreshedTokens(
      login,
      await requestRefresh(login.tokens.refresh_token),
      attemptedAt,
    );
  } catch (error) {
    await updateStatus(env, {
      last_attempt_at: attemptedAt,
      last_error: errorMessage(error),
    });
    console.error(`Codex token refresh failed: ${errorMessage(error)}`);

    return { refreshed: false, reason: errorMessage(error) };
  }

  const sealed = await sealBundle(refreshedLogin, env.BUNDLE_KEY);

  // The old refresh token is spent at this point, so the new login
  // must land even through a transient KV failure.
  await storeSealedLogin(env.CODEX_AUTH, sealed);

  await updateStatus(env, { last_attempt_at: attemptedAt, last_error: null });

  return { refreshed: true };
}

async function storeSealedLogin(
  store: LoginStore,
  sealed: string,
  attempt = 1,
): Promise<void> {
  try {
    await store.put(BUNDLE_KV_KEY, sealed);
  } catch (error) {
    if (attempt === KV_PUT_ATTEMPTS) {
      console.error(
        `Unable to store the refreshed Codex login after ${KV_PUT_ATTEMPTS} attempts: ${errorMessage(error)}`,
      );

      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    await storeSealedLogin(store, sealed, attempt + 1);
  }
}

function isRefreshResponse(value: unknown): value is RefreshResponse {
  return isRecord(value) && typeof value.access_token === "string";
}

async function requestRefresh(refreshToken: unknown): Promise<RefreshResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: String(refreshToken),
      client_id: CLIENT_ID,
    }),
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok || !isRefreshResponse(body)) {
    const error = isRecord(body) ? body.error : undefined;
    const reason =
      (isRecord(error) ? error.code : undefined) ?? error ?? "no error code";

    throw new Error(
      `OpenAI answered ${response.status} (${typeof reason === "string" ? reason : JSON.stringify(reason)}).`,
    );
  }

  return body;
}

function withRefreshedTokens(
  login: StoredLogin,
  response: RefreshResponse,
  refreshedAt: string,
): StoredLogin {
  return {
    ...login,
    tokens: {
      ...login.tokens,
      access_token: response.access_token,
      id_token: response.id_token ?? login.tokens.id_token,
      refresh_token: response.refresh_token ?? login.tokens.refresh_token,
    },
    last_refresh: refreshedAt,
  };
}

/**
 * The login a client stores as its Codex auth.json. The empty
 * refresh token keeps clients from refreshing on their own.
 */
function clientLogin(login: StoredLogin) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: login.tokens.id_token,
      access_token: login.tokens.access_token,
      refresh_token: "",
      account_id: login.tokens.account_id,
    },
    last_refresh: login.last_refresh,
  };
}

async function loadLogin(env: WorkerEnv): Promise<StoredLogin | null> {
  const sealed = await env.CODEX_AUTH.get(BUNDLE_KV_KEY);

  return sealed ? openBundle(sealed, env.BUNDLE_KEY) : null;
}

async function loadStatus(env: WorkerEnv): Promise<Record<string, unknown>> {
  const stored = await env.CODEX_AUTH.get(STATUS_KV_KEY);
  const status: unknown = stored === null ? null : JSON.parse(stored);

  return isRecord(status) ? status : {};
}

async function updateStatus(
  env: WorkerEnv,
  fields: Record<string, unknown>,
): Promise<void> {
  await env.CODEX_AUTH.put(
    STATUS_KV_KEY,
    JSON.stringify({ ...(await loadStatus(env)), ...fields }),
  );
}

/**
 * Compares SHA-256 digests in constant time, so response timing
 * reveals nothing about how much of a guessed token matched.
 */
async function hasServeToken(
  request: Request,
  serveToken: string,
): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  const [presentedDigest, expectedDigest] = await Promise.all([
    digest(presented),
    digest(serveToken),
  ]);

  return (
    presentedDigest.reduce(
      (difference, byte, index) =>
        difference | (byte ^ (expectedDigest[index] ?? 0)),
      0,
    ) === 0
  );
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/** A value for a message: a string as is, anything else as JSON. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
