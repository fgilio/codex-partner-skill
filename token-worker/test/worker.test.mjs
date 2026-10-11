import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import {
  accessTokenExpiryMs,
  generateBundleKey,
  openBundle,
  sealBundle,
} from "../src/bundle.mjs";
import {
  BUNDLE_KV_KEY,
  STATUS_KV_KEY,
  handleRequest,
  refreshIfExpiring,
} from "../src/index.mjs";
import { makeJwt } from "../../test/fixtures/jwt.mjs";

const HOUR_MS = 60 * 60 * 1000;

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

async function storeLogin(login) {
  await env.CODEX_AUTH.put(
    BUNDLE_KV_KEY,
    await sealBundle(login, env.BUNDLE_KEY),
  );
}

async function readStoredLogin() {
  return openBundle(await env.CODEX_AUTH.get(BUNDLE_KV_KEY), env.BUNDLE_KEY);
}

function request(path, { token = "serve-secret", method = "GET" } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  return handleRequest(
    new Request(`https://worker.test${path}`, { method, headers }),
    env,
  );
}

function stubOpenAi(status, body) {
  globalThis.fetch.mock.mockImplementation(async () =>
    Response.json(body, { status }),
  );
}

function openAiRequest(index = 0) {
  const [url, init] = globalThis.fetch.mock.calls[index].arguments;

  return { url: String(url), body: new URLSearchParams(init.body) };
}

beforeEach(() => {
  env = {
    CODEX_AUTH: new MemoryKv(),
    SERVE_TOKEN: "serve-secret",
    BUNDLE_KEY: generateBundleKey(),
  };
  mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network call");
  });
});

afterEach(() => mock.restoreAll());

describe("GET /auth.json", () => {
  test("serves the stored login without its refresh token", async () => {
    const login = storedLogin(5 * 24 * HOUR_MS);
    await storeLogin(login);

    const response = await request("/auth.json");
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(body, {
      ...login,
      tokens: { ...login.tokens, refresh_token: "" },
    });
  });

  test("rejects a missing or wrong bearer token", async () => {
    await storeLogin(storedLogin(5 * 24 * HOUR_MS));

    assert.equal((await request("/auth.json", { token: null })).status, 401);
    assert.equal((await request("/auth.json", { token: "guess" })).status, 401);
  });

  test("points at the seed script when no login is stored", async () => {
    const response = await request("/auth.json");

    assert.equal(response.status, 503);
    assert.match(
      (await response.json()).error,
      /No Codex login is stored\. Run `node token-worker\/scripts\/seed\.mjs`/,
    );
  });

  test("refuses an access token with less than an hour left and names the last refresh failure", async () => {
    await storeLogin(storedLogin(HOUR_MS / 2));
    await env.CODEX_AUTH.put(
      STATUS_KV_KEY,
      JSON.stringify({ last_error: "OpenAI answered 400 (invalid_grant)." }),
    );

    const response = await request("/auth.json");

    assert.equal(response.status, 503);
    assert.match(
      (await response.json()).error,
      /less than an hour left\. The last refresh failed: OpenAI answered 400 \(invalid_grant\)/,
    );
  });

  test("refuses a stored access token with no readable expiry", async () => {
    const login = storedLogin(5 * 24 * HOUR_MS);
    login.tokens.access_token = "not-a-jwt";
    await storeLogin(login);

    const response = await request("/auth.json");

    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /no readable expiry/);
  });

  test("reports a login sealed under another BUNDLE_KEY", async () => {
    await storeLogin(storedLogin(5 * 24 * HOUR_MS));
    env.BUNDLE_KEY = generateBundleKey();

    const response = await request("/auth.json");

    assert.equal(response.status, 503);
    assert.match(
      (await response.json()).error,
      /Unable to open the stored login: The sealed login does not decrypt with the current BUNDLE_KEY\./,
    );
  });

  test("fails clearly when the SERVE_TOKEN secret is missing", async () => {
    delete env.SERVE_TOKEN;

    const response = await request("/auth.json");

    assert.equal(response.status, 500);
    assert.match(
      (await response.json()).error,
      /SERVE_TOKEN secret is not set/,
    );
  });

  test("answers only GET on known paths", async () => {
    assert.equal((await request("/auth.json", { method: "POST" })).status, 405);
    assert.equal((await request("/secrets")).status, 404);
  });
});

describe("GET /status", () => {
  test("reports the access token expiry and the last refresh outcome", async () => {
    const login = storedLogin(5 * 24 * HOUR_MS);
    await storeLogin(login);
    await env.CODEX_AUTH.put(
      STATUS_KV_KEY,
      JSON.stringify({
        last_attempt_at: "2026-01-02T00:00:00.000Z",
        last_error: null,
      }),
    );

    const body = await (await request("/status")).json();

    assert.equal(
      body.access_expires_at,
      new Date(accessTokenExpiryMs(login.tokens.access_token)).toISOString(),
    );
    assert.equal(body.last_refresh, login.last_refresh);
    assert.equal(body.last_attempt_at, "2026-01-02T00:00:00.000Z");
    assert.equal(body.last_error, null);
  });
});

describe("scheduled refresh", () => {
  test("leaves a login alone while it has more than 36 hours left", async () => {
    await storeLogin(storedLogin(48 * HOUR_MS));

    const outcome = await refreshIfExpiring(env);

    assert.equal(outcome.refreshed, false);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });

  test("refreshes an expiring login and stores the rotated refresh token", async () => {
    await storeLogin(storedLogin(20 * HOUR_MS));
    const newAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 10 * 24 * HOUR_MS) / 1000),
    });
    stubOpenAi(200, {
      access_token: newAccessToken,
      id_token: "id-2",
      refresh_token: "refresh-2",
      expires_in: 864000,
    });

    const outcome = await refreshIfExpiring(env);
    const stored = await readStoredLogin();
    const { url, body } = openAiRequest();

    assert.equal(outcome.refreshed, true);
    assert.equal(url, "https://auth.openai.com/oauth/token");
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "refresh-1");
    assert.equal(body.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(stored.tokens.access_token, newAccessToken);
    assert.equal(stored.tokens.id_token, "id-2");
    assert.equal(stored.tokens.refresh_token, "refresh-2");
    assert.equal(stored.tokens.account_id, "account-1");
    assert.deepEqual(await env.CODEX_AUTH.get(STATUS_KV_KEY, "json"), {
      last_attempt_at: stored.last_refresh,
      last_error: null,
    });
  });

  test("keeps the current refresh token when OpenAI does not rotate it", async () => {
    await storeLogin(storedLogin(20 * HOUR_MS));
    stubOpenAi(200, {
      access_token: makeJwt({
        exp: Math.floor((Date.now() + 10 * 24 * HOUR_MS) / 1000),
      }),
    });

    await refreshIfExpiring(env);

    assert.equal((await readStoredLogin()).tokens.refresh_token, "refresh-1");
  });

  test("records a rejected refresh and keeps the stored login", async () => {
    const login = storedLogin(20 * HOUR_MS);
    await storeLogin(login);
    stubOpenAi(400, {
      error: "invalid_grant",
      error_description: "Refresh token reused",
    });

    const outcome = await refreshIfExpiring(env);

    assert.equal(outcome.refreshed, false);
    assert.deepEqual(await readStoredLogin(), login);
    assert.match(
      (await env.CODEX_AUTH.get(STATUS_KV_KEY, "json")).last_error,
      /OpenAI answered 400 \(invalid_grant\)/,
    );
  });

  test("retries storing the refreshed login through transient KV failures", async () => {
    await storeLogin(storedLogin(20 * HOUR_MS));
    stubOpenAi(200, {
      access_token: makeJwt({
        exp: Math.floor((Date.now() + 10 * 24 * HOUR_MS) / 1000),
      }),
      refresh_token: "refresh-2",
    });
    env.CODEX_AUTH.failingPuts = 2;

    const outcome = await refreshIfExpiring(env);

    assert.equal(outcome.refreshed, true);
    assert.equal((await readStoredLogin()).tokens.refresh_token, "refresh-2");
  });

  test("keeps earlier status fields when it records a refresh", async () => {
    await storeLogin(storedLogin(20 * HOUR_MS));
    await env.CODEX_AUTH.put(
      STATUS_KV_KEY,
      JSON.stringify({
        seeded_at: "2026-01-01T00:00:00.000Z",
        last_error: null,
      }),
    );
    stubOpenAi(200, {
      access_token: makeJwt({
        exp: Math.floor((Date.now() + 10 * 24 * HOUR_MS) / 1000),
      }),
    });

    await refreshIfExpiring(env);

    assert.equal(
      (await env.CODEX_AUTH.get(STATUS_KV_KEY, "json")).seeded_at,
      "2026-01-01T00:00:00.000Z",
    );
  });

  test("does nothing before a login is stored", async () => {
    assert.deepEqual(await refreshIfExpiring(env), {
      refreshed: false,
      reason: "no login stored",
    });
  });
});

describe("bundle sealing", () => {
  test("round-trips a login", async () => {
    const key = generateBundleKey();
    const login = storedLogin(HOUR_MS);

    assert.deepEqual(
      await openBundle(await sealBundle(login, key), key),
      login,
    );
  });

  test("rejects a key that is not 32 bytes of base64", async () => {
    const login = storedLogin(HOUR_MS);

    await assert.rejects(sealBundle(login, "c2hvcnQ="), /32 random bytes/);
    await assert.rejects(sealBundle(login, "not base64!"), /32 random bytes/);
  });

  test("keeps the refresh token out of the sealed value", async () => {
    const sealed = await sealBundle(storedLogin(HOUR_MS), generateBundleKey());

    assert.ok(!sealed.includes("refresh-1"));
  });
});
