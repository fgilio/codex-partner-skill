/**
 * Serves short-lived Codex access tokens from one ChatGPT login.
 *
 * The scheduled handler is the only code that refreshes the login:
 * a refresh rotates the refresh token, so a second refresher
 * would spend it. Clients receive the access token alone.
 */

import { accessTokenExpiryMs, openBundle, sealBundle } from "./bundle.mjs";

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
  "Run `node token-worker/scripts/seed.mjs` to store a fresh login.";

export default {
  fetch: handleRequest,
  scheduled: (controller, env, context) =>
    context.waitUntil(refreshIfExpiring(env)),
};

export async function handleRequest(request, env) {
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

  let login;

  try {
    login = await loadLogin(env);
  } catch (error) {
    return json(
      {
        error: `Unable to open the stored login: ${error.message} ${SEED_HINT}`,
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
    const cause = lastError ? ` The last refresh failed: ${lastError}` : "";

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
export async function refreshIfExpiring(env, now = Date.now()) {
  const login = await loadLogin(env);

  if (!login) {
    return { refreshed: false, reason: "no login stored" };
  }

  if (accessTokenExpiryMs(login.tokens.access_token) - now > REFRESH_BELOW_MS) {
    return { refreshed: false, reason: "access token still fresh" };
  }

  const attemptedAt = new Date(now).toISOString();
  let refreshedLogin;

  try {
    refreshedLogin = withRefreshedTokens(
      login,
      await requestRefresh(login.tokens.refresh_token),
      attemptedAt,
    );
  } catch (error) {
    await updateStatus(env, {
      last_attempt_at: attemptedAt,
      last_error: error.message,
    });
    console.error(`Codex token refresh failed: ${error.message}`);

    return { refreshed: false, reason: error.message };
  }

  const sealed = await sealBundle(refreshedLogin, env.BUNDLE_KEY);

  // The old refresh token is spent at this point, so the new login
  // must land even through a transient KV failure.
  for (let attempt = 1; ; attempt++) {
    try {
      await env.CODEX_AUTH.put(BUNDLE_KV_KEY, sealed);
      break;
    } catch (error) {
      if (attempt === KV_PUT_ATTEMPTS) {
        console.error(
          `Unable to store the refreshed Codex login after ${KV_PUT_ATTEMPTS} attempts: ${error.message}`,
        );

        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  await updateStatus(env, { last_attempt_at: attemptedAt, last_error: null });

  return { refreshed: true };
}

async function requestRefresh(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || typeof body?.access_token !== "string") {
    const reason = body?.error?.code ?? body?.error ?? "no error code";

    throw new Error(
      `OpenAI answered ${response.status} (${typeof reason === "string" ? reason : JSON.stringify(reason)}).`,
    );
  }

  return body;
}

function withRefreshedTokens(login, response, refreshedAt) {
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
function clientLogin(login) {
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

async function loadLogin(env) {
  const sealed = await env.CODEX_AUTH.get(BUNDLE_KV_KEY);

  return sealed ? openBundle(sealed, env.BUNDLE_KEY) : null;
}

async function loadStatus(env) {
  return (await env.CODEX_AUTH.get(STATUS_KV_KEY, "json")) ?? {};
}

async function updateStatus(env, fields) {
  await env.CODEX_AUTH.put(
    STATUS_KV_KEY,
    JSON.stringify({ ...(await loadStatus(env)), ...fields }),
  );
}

/**
 * Compares SHA-256 digests in constant time, so response timing
 * reveals nothing about how much of a guessed token matched.
 */
async function hasServeToken(request, serveToken) {
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
      (difference, byte, index) => difference | (byte ^ expectedDigest[index]),
      0,
    ) === 0
  );
}

async function digest(value) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
