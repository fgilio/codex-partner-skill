import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  accessTokenExpiry,
  generateBundleKey,
  openBundle,
  sealBundle,
} from "../src/bundle.mjs";
import { handleRequest, refreshIfExpiring } from "../src/index.mjs";

const HOUR = 60 * 60 * 1000;
const originalFetch = globalThis.fetch;

class MemoryKv {
  values = new Map();
  failingPuts = 0;

  async get(key, type) {
    const value = this.values.get(key) ?? null;

    return value !== null && type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value) {
    if (this.failingPuts > 0) {
      this.failingPuts--;

      throw new Error("KV is unavailable");
    }

    this.values.set(key, value);
  }
}

function makeJwt(claims) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

function storedLogin(expiresInMs) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: makeJwt({ email: "user@example.com" }),
      access_token: makeJwt({
        exp: Math.floor((Date.now() + expiresInMs) / 1000),
      }),
      refresh_token: "refresh-1",
      account_id: "account-1",
    },
    last_refresh: "2026-01-01T00:00:00.000Z",
  };
}

let env;
let fetchCalls;

async function storeLogin(login) {
  await env.CODEX_AUTH.put("bundle", await sealBundle(login, env.BUNDLE_KEY));
}

async function readStoredLogin() {
  return openBundle(await env.CODEX_AUTH.get("bundle"), env.BUNDLE_KEY);
}

function get(path, { token = "serve-secret", method = "GET" } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  return handleRequest(
    new Request(`https://worker.test${path}`, { method, headers }),
    env,
  );
}

function stubOpenAi(status, body) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), body: new URLSearchParams(init.body) });

    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

beforeEach(() => {
  env = {
    CODEX_AUTH: new MemoryKv(),
    SERVE_TOKEN: "serve-secret",
    BUNDLE_KEY: generateBundleKey(),
  };
  fetchCalls = [];
  globalThis.fetch = async () => {
    throw new Error("Unexpected network call");
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GET /auth.json", () => {
  test("serves the stored login without its refresh token", async () => {
    const login = storedLogin(5 * 24 * HOUR);
    await storeLogin(login);

    const response = await get("/auth.json");
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(body, {
      ...login,
      tokens: { ...login.tokens, refresh_token: "" },
    });
  });

  test("rejects a missing or wrong bearer token", async () => {
    await storeLogin(storedLogin(5 * 24 * HOUR));

    assert.equal((await get("/auth.json", { token: null })).status, 401);
    assert.equal((await get("/auth.json", { token: "guess" })).status, 401);
  });

  test("points at the seed script when no login is stored", async () => {
    const response = await get("/auth.json");

    assert.equal(response.status, 503);
    assert.match(
      (await response.json()).error,
      /No Codex login is stored\. Run `node token-worker\/scripts\/seed\.mjs`/,
    );
  });

  test("refuses an expired access token and names the last refresh failure", async () => {
    await storeLogin(storedLogin(-HOUR));
    await env.CODEX_AUTH.put(
      "status",
      JSON.stringify({ last_error: "OpenAI answered 400 (invalid_grant)." }),
    );

    const response = await get("/auth.json");

    assert.equal(response.status, 503);
    assert.match(
      (await response.json()).error,
      /expired\. The last refresh failed: OpenAI answered 400 \(invalid_grant\)/,
    );
  });

  test("reports a login sealed under another BUNDLE_KEY", async () => {
    await storeLogin(storedLogin(5 * 24 * HOUR));
    env.BUNDLE_KEY = generateBundleKey();

    const response = await get("/auth.json");

    assert.equal(response.status, 503);
    assert.match(
      (await response.json()).error,
      /Unable to open the stored login/,
    );
  });

  test("fails clearly when the SERVE_TOKEN secret is missing", async () => {
    delete env.SERVE_TOKEN;

    const response = await get("/auth.json");

    assert.equal(response.status, 500);
    assert.match(
      (await response.json()).error,
      /SERVE_TOKEN secret is not set/,
    );
  });

  test("answers only GET on known paths", async () => {
    assert.equal((await get("/auth.json", { method: "POST" })).status, 405);
    assert.equal((await get("/secrets")).status, 404);
  });
});

describe("GET /status", () => {
  test("reports the access token expiry and the last refresh outcome", async () => {
    const login = storedLogin(5 * 24 * HOUR);
    await storeLogin(login);
    await env.CODEX_AUTH.put(
      "status",
      JSON.stringify({
        last_attempt_at: "2026-01-02T00:00:00.000Z",
        last_error: null,
      }),
    );

    const body = await (await get("/status")).json();

    assert.equal(
      body.access_expires_at,
      new Date(accessTokenExpiry(login.tokens.access_token)).toISOString(),
    );
    assert.equal(body.last_refresh, login.last_refresh);
    assert.equal(body.last_attempt_at, "2026-01-02T00:00:00.000Z");
    assert.equal(body.last_error, null);
  });
});

describe("scheduled refresh", () => {
  test("leaves a login alone while it has more than 36 hours left", async () => {
    await storeLogin(storedLogin(48 * HOUR));

    const outcome = await refreshIfExpiring(env);

    assert.equal(outcome.refreshed, false);
    assert.equal(fetchCalls.length, 0);
  });

  test("refreshes an expiring login and stores the rotated refresh token", async () => {
    await storeLogin(storedLogin(20 * HOUR));
    const newAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 10 * 24 * HOUR) / 1000),
    });
    stubOpenAi(200, {
      access_token: newAccessToken,
      id_token: "id-2",
      refresh_token: "refresh-2",
      expires_in: 864000,
    });

    const outcome = await refreshIfExpiring(env);
    const stored = await readStoredLogin();

    assert.equal(outcome.refreshed, true);
    assert.equal(fetchCalls[0].url, "https://auth.openai.com/oauth/token");
    assert.equal(fetchCalls[0].body.get("grant_type"), "refresh_token");
    assert.equal(fetchCalls[0].body.get("refresh_token"), "refresh-1");
    assert.equal(
      fetchCalls[0].body.get("client_id"),
      "app_EMoamEEZ73f0CkXaXp7hrann",
    );
    assert.equal(stored.tokens.access_token, newAccessToken);
    assert.equal(stored.tokens.id_token, "id-2");
    assert.equal(stored.tokens.refresh_token, "refresh-2");
    assert.equal(stored.tokens.account_id, "account-1");
    assert.deepEqual(await env.CODEX_AUTH.get("status", "json"), {
      last_attempt_at: stored.last_refresh,
      last_error: null,
    });
  });

  test("keeps the current refresh token when OpenAI does not rotate it", async () => {
    await storeLogin(storedLogin(20 * HOUR));
    stubOpenAi(200, {
      access_token: makeJwt({
        exp: Math.floor((Date.now() + 10 * 24 * HOUR) / 1000),
      }),
    });

    await refreshIfExpiring(env);

    assert.equal((await readStoredLogin()).tokens.refresh_token, "refresh-1");
  });

  test("records a rejected refresh and keeps the stored login", async () => {
    const login = storedLogin(20 * HOUR);
    await storeLogin(login);
    stubOpenAi(400, {
      error: "invalid_grant",
      error_description: "Refresh token reused",
    });

    const outcome = await refreshIfExpiring(env);

    assert.equal(outcome.refreshed, false);
    assert.deepEqual(await readStoredLogin(), login);
    assert.match(
      (await env.CODEX_AUTH.get("status", "json")).last_error,
      /OpenAI answered 400 \(invalid_grant\)/,
    );
  });

  test("retries storing the refreshed login through transient KV failures", async () => {
    await storeLogin(storedLogin(20 * HOUR));
    stubOpenAi(200, {
      access_token: makeJwt({
        exp: Math.floor((Date.now() + 10 * 24 * HOUR) / 1000),
      }),
      refresh_token: "refresh-2",
    });
    env.CODEX_AUTH.failingPuts = 2;

    const outcome = await refreshIfExpiring(env);

    assert.equal(outcome.refreshed, true);
    assert.equal((await readStoredLogin()).tokens.refresh_token, "refresh-2");
  });

  test("does nothing before a login is stored", async () => {
    assert.deepEqual(await refreshIfExpiring(env), {
      refreshed: false,
      reason: "no login stored",
    });
  });
});

describe("bundle sealing", () => {
  test("round-trips a login and rejects a key that is not 32 bytes", async () => {
    const key = generateBundleKey();
    const login = storedLogin(HOUR);

    assert.deepEqual(
      await openBundle(await sealBundle(login, key), key),
      login,
    );
    await assert.rejects(sealBundle(login, "c2hvcnQ="), /32 random bytes/);
  });

  test("keeps the refresh token out of the sealed value", async () => {
    const sealed = await sealBundle(storedLogin(HOUR), generateBundleKey());

    assert.ok(!sealed.includes("refresh-1"));
  });
});
