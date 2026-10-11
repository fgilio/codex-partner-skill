/**
 * Serves short-lived Codex access tokens from one ChatGPT login.
 *
 * The scheduled handler is the only code that refreshes the login,
 * because a refresh rotates the refresh token and any second
 * refresher would spend it. Clients get the access token alone.
 */

import { accessTokenExpiry, openBundle, sealBundle } from "./bundle.mjs";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// The cron runs every 6 hours, so a refresh that keeps failing still
// leaves more than a day of valid access before clients notice.
const REFRESH_BELOW_MS = 36 * 60 * 60 * 1000;
const SERVE_BELOW_MS = 5 * 60 * 1000;

const BUNDLE_KEY = "bundle";
const STATUS_KEY = "status";
const SEED_HINT =
  "Run `node token-worker/scripts/seed.mjs` to store a fresh login.";

export default {
  fetch: (request, env) => handleRequest(request, env),
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
    return json({ error: "Missing or invalid bearer token." }, 401);
  }

  let bundle;

  try {
    bundle = await loadBundle(env);
  } catch (error) {
    return json(
      {
        error: `Unable to open the stored login: ${error.message} ${SEED_HINT}`,
      },
      503,
    );
  }

  if (!bundle) {
    return json({ error: `No Codex login is stored. ${SEED_HINT}` }, 503);
  }

  const status = (await env.CODEX_AUTH.get(STATUS_KEY, "json")) ?? {};
  const expiresAt = accessTokenExpiry(bundle.tokens.access_token);

  if (pathname === "/status") {
    return json({
      access_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      last_refresh: bundle.last_refresh ?? null,
      ...status,
    });
  }

  if (!expiresAt || expiresAt - Date.now() < SERVE_BELOW_MS) {
    const cause = status.last_error
      ? ` The last refresh failed: ${status.last_error}`
      : "";

    return json(
      { error: `The stored access token is expired.${cause} ${SEED_HINT}` },
      503,
    );
  }

  return json(consumerLogin(bundle));
}

/**
 * Refreshes the stored login once its access token has less than
 * REFRESH_BELOW_MS left. A failure leaves the stored login intact.
 */
export async function refreshIfExpiring(env, now = Date.now()) {
  const bundle = await loadBundle(env);

  if (!bundle) {
    return { refreshed: false, reason: "no login stored" };
  }

  if (accessTokenExpiry(bundle.tokens.access_token) - now > REFRESH_BELOW_MS) {
    return { refreshed: false, reason: "access token still fresh" };
  }

  const attemptedAt = new Date(now).toISOString();
  let refreshedBundle;

  try {
    refreshedBundle = withRefreshedTokens(
      bundle,
      await requestRefresh(bundle.tokens.refresh_token),
      attemptedAt,
    );
  } catch (error) {
    await env.CODEX_AUTH.put(
      STATUS_KEY,
      JSON.stringify({
        last_attempt_at: attemptedAt,
        last_error: error.message,
      }),
    );
    console.error(`Codex token refresh failed: ${error.message}`);

    return { refreshed: false, reason: error.message };
  }

  // The old refresh token is spent at this point, so the new bundle
  // must land even through a transient KV failure.
  await withRetries(async () =>
    env.CODEX_AUTH.put(
      BUNDLE_KEY,
      await sealBundle(refreshedBundle, env.BUNDLE_KEY),
    ),
  );
  await env.CODEX_AUTH.put(
    STATUS_KEY,
    JSON.stringify({ last_attempt_at: attemptedAt, last_error: null }),
  );

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

function withRefreshedTokens(bundle, response, refreshedAt) {
  return {
    ...bundle,
    tokens: {
      ...bundle.tokens,
      access_token: response.access_token,
      id_token: response.id_token ?? bundle.tokens.id_token,
      refresh_token: response.refresh_token ?? bundle.tokens.refresh_token,
    },
    last_refresh: refreshedAt,
  };
}

/**
 * The login a client stores as its Codex auth.json. The empty
 * refresh token keeps clients from refreshing on their own.
 */
function consumerLogin(bundle) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: bundle.tokens.id_token,
      access_token: bundle.tokens.access_token,
      refresh_token: "",
      account_id: bundle.tokens.account_id,
    },
    last_refresh: bundle.last_refresh,
  };
}

async function loadBundle(env) {
  const sealed = await env.CODEX_AUTH.get(BUNDLE_KEY);

  return sealed ? openBundle(sealed, env.BUNDLE_KEY) : null;
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

async function withRetries(operation, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts) {
        console.error(
          `Unable to store the refreshed Codex login after ${attempts} attempts: ${error.message}`,
        );

        throw error;
      }
    }
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
