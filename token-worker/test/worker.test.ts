import type { KVNamespace } from "@cloudflare/workers-types";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  spyOn,
  test,
} from "bun:test";
import type { Mock } from "bun:test";

import { makeJwt } from "../../test/fixtures/jwt";
import { rejectionMessage } from "../../test/fixtures/rejection";
import {
  accessTokenExpiryMs,
  generateBundleKey,
  isRecord,
  openBundle,
  sealBundle,
} from "../src/bundle";
import type { StoredLogin } from "../src/bundle";
import worker, {
  BUNDLE_KV_KEY,
  STATUS_KV_KEY,
  handleRequest,
  refreshIfExpiring,
} from "../src/index";
import type { LoginStore, WorkerEnv } from "../src/index";

const HOUR_MS = 60 * 60 * 1000;

class MemoryKv implements LoginStore {
  values = new Map<string, string>();
  failingPuts = 0;

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  put(key: string, value: string): Promise<void> {
    if (this.failingPuts > 0) {
      this.failingPuts--;

      return Promise.reject(new Error("KV is unavailable"));
    }

    this.values.set(key, value);

    return Promise.resolve();
  }
}

function storedLogin(expiresInMs: number) {
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

let kv: MemoryKv;
let env: WorkerEnv;
let fetchMock: Mock<typeof fetch>;

async function storeLogin(login: StoredLogin): Promise<void> {
  await kv.put(BUNDLE_KV_KEY, await sealBundle(login, env.BUNDLE_KEY));
}

async function readStoredLogin(): Promise<StoredLogin> {
  const sealed = await kv.get(BUNDLE_KV_KEY);

  if (sealed === null) {
    throw new Error("No login is stored.");
  }

  return openBundle(sealed, env.BUNDLE_KEY);
}

async function readStatus(): Promise<Record<string, unknown>> {
  const status: unknown = JSON.parse((await kv.get(STATUS_KV_KEY)) ?? "null");

  if (!isRecord(status)) {
    throw new Error("No status is stored.");
  }

  return status;
}

function request(
  path: string,
  {
    token = "serve-secret",
    method = "GET",
  }: { token?: string | null; method?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  return handleRequest(
    new Request(`https://worker.test${path}`, { method, headers }),
    env,
  );
}

async function errorOf(response: Response): Promise<string> {
  const body: unknown = await response.json();

  return isRecord(body) && typeof body.error === "string" ? body.error : "";
}

/** A fetch that answers every call with `answer`. */
function fakeFetch(answer: () => Promise<Response>): typeof fetch {
  return Object.assign(answer, { preconnect: () => undefined });
}

function stubOpenAi(status: number, body: unknown): void {
  fetchMock.mockImplementation(
    fakeFetch(() => Promise.resolve(Response.json(body, { status }))),
  );
}

function openAiRequest(index = 0): { url: string; body: URLSearchParams } {
  const call = fetchMock.mock.calls[index];

  if (call === undefined) {
    throw new Error(`OpenAI was called fewer than ${index + 1} times.`);
  }

  const [url, init] = call;
  const body = init?.body;

  if (!(body instanceof URLSearchParams)) {
    throw new TypeError("The refresh request has no form body.");
  }

  return {
    url: url instanceof Request ? url.url : String(url),
    body,
  };
}

beforeEach(() => {
  kv = new MemoryKv();
  env = {
    CODEX_AUTH: kv,
    SERVE_TOKEN: "serve-secret",
    BUNDLE_KEY: generateBundleKey(),
  };
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    fakeFetch(() => Promise.reject(new Error("Unexpected network call"))),
  );
});

afterEach(() => {
  fetchMock.mockRestore();
});

describe("GET /auth.json", () => {
  test("serves the stored login without its refresh token", async () => {
    const login = storedLogin(5 * 24 * HOUR_MS);
    await storeLogin(login);

    const response = await request("/auth.json");
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      ...login,
      tokens: { ...login.tokens, refresh_token: "" },
    });
  });

  test("rejects a missing or wrong bearer token", async () => {
    await storeLogin(storedLogin(5 * 24 * HOUR_MS));

    expect((await request("/auth.json", { token: null })).status).toBe(401);
    expect((await request("/auth.json", { token: "guess" })).status).toBe(401);
  });

  test("points at the seed script when no login is stored", async () => {
    const response = await request("/auth.json");

    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatch(
      /No Codex login is stored\. Run `bun token-worker\/scripts\/seed\.ts`/,
    );
  });

  test("refuses an access token with less than an hour left and names the last refresh failure", async () => {
    await storeLogin(storedLogin(HOUR_MS / 2));
    await kv.put(
      STATUS_KV_KEY,
      JSON.stringify({ last_error: "OpenAI answered 400 (invalid_grant)." }),
    );

    const response = await request("/auth.json");

    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatch(
      /less than an hour left\. The last refresh failed: OpenAI answered 400 \(invalid_grant\)/,
    );
  });

  test("refuses a stored access token with no readable expiry", async () => {
    const login = storedLogin(5 * 24 * HOUR_MS);
    login.tokens.access_token = "not-a-jwt";
    await storeLogin(login);

    const response = await request("/auth.json");

    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatch(/no readable expiry/);
  });

  test("reports a login sealed under another BUNDLE_KEY", async () => {
    await storeLogin(storedLogin(5 * 24 * HOUR_MS));
    env.BUNDLE_KEY = generateBundleKey();

    const response = await request("/auth.json");

    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatch(
      /Unable to open the stored login: The sealed login does not decrypt with the current BUNDLE_KEY\./,
    );
  });

  test("reports a stored bundle of another version", async () => {
    await kv.put(BUNDLE_KV_KEY, JSON.stringify({ version: 2 }));

    const response = await request("/auth.json");

    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatch(
      /The stored bundle has version 2, and this worker reads version 1\./,
    );
  });

  test("fails clearly when the SERVE_TOKEN secret is missing", async () => {
    delete env.SERVE_TOKEN;

    const response = await request("/auth.json");

    expect(response.status).toBe(500);
    expect(await errorOf(response)).toMatch(/SERVE_TOKEN secret is not set/);
  });

  test("answers only GET on known paths", async () => {
    expect((await request("/auth.json", { method: "POST" })).status).toBe(405);
    expect((await request("/secrets")).status).toBe(404);
  });
});

describe("GET /status", () => {
  test("reports the access token expiry and the last refresh outcome", async () => {
    const login = storedLogin(5 * 24 * HOUR_MS);
    await storeLogin(login);
    await kv.put(
      STATUS_KV_KEY,
      JSON.stringify({
        last_attempt_at: "2026-01-02T00:00:00.000Z",
        last_error: null,
      }),
    );

    const body: unknown = await (await request("/status")).json();

    expect(body).toEqual({
      access_expires_at: new Date(
        accessTokenExpiryMs(login.tokens.access_token) ?? 0,
      ).toISOString(),
      last_refresh: login.last_refresh,
      last_attempt_at: "2026-01-02T00:00:00.000Z",
      last_error: null,
    });
  });
});

describe("scheduled refresh", () => {
  test("leaves a login alone while it has more than 36 hours left", async () => {
    await storeLogin(storedLogin(48 * HOUR_MS));

    const outcome = await refreshIfExpiring(env);

    expect(outcome.refreshed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
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

    expect(outcome.refreshed).toBe(true);
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-1");
    expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(stored.tokens.access_token).toBe(newAccessToken);
    expect(stored.tokens.id_token).toBe("id-2");
    expect(stored.tokens.refresh_token).toBe("refresh-2");
    expect(stored.tokens.account_id).toBe("account-1");
    expect(await readStatus()).toEqual({
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

    expect((await readStoredLogin()).tokens.refresh_token).toBe("refresh-1");
  });

  test("records a rejected refresh and keeps the stored login", async () => {
    const login = storedLogin(20 * HOUR_MS);
    await storeLogin(login);
    stubOpenAi(400, {
      error: "invalid_grant",
      error_description: "Refresh token reused",
    });
    const logged = spyOn(console, "error").mockImplementation(() => undefined);

    const outcome = await refreshIfExpiring(env);
    logged.mockRestore();

    expect(outcome.refreshed).toBe(false);
    expect(await readStoredLogin()).toEqual(login);
    expect(String((await readStatus()).last_error)).toMatch(
      /OpenAI answered 400 \(invalid_grant\)/,
    );
  });

  test("names the error code OpenAI nests in an error object", async () => {
    await storeLogin(storedLogin(20 * HOUR_MS));
    stubOpenAi(401, { error: { code: "refresh_token_expired" } });
    const logged = spyOn(console, "error").mockImplementation(() => undefined);

    const outcome = await refreshIfExpiring(env);
    logged.mockRestore();

    expect(outcome).toEqual({
      refreshed: false,
      reason: "OpenAI answered 401 (refresh_token_expired).",
    });
  });

  test("retries storing the refreshed login through transient KV failures", async () => {
    await storeLogin(storedLogin(20 * HOUR_MS));
    stubOpenAi(200, {
      access_token: makeJwt({
        exp: Math.floor((Date.now() + 10 * 24 * HOUR_MS) / 1000),
      }),
      refresh_token: "refresh-2",
    });
    kv.failingPuts = 2;

    const outcome = await refreshIfExpiring(env);

    expect(outcome.refreshed).toBe(true);
    expect((await readStoredLogin()).tokens.refresh_token).toBe("refresh-2");
  });

  test("keeps earlier status fields when it records a refresh", async () => {
    await storeLogin(storedLogin(20 * HOUR_MS));
    await kv.put(
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

    expect((await readStatus()).seeded_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("does nothing before a login is stored", async () => {
    expect(await refreshIfExpiring(env)).toEqual({
      refreshed: false,
      reason: "no login stored",
    });
  });

  test("the cron handler hands the refresh to waitUntil", async () => {
    await storeLogin(storedLogin(48 * HOUR_MS));
    const pending: Promise<unknown>[] = [];

    worker.scheduled(
      { scheduledTime: Date.now(), cron: "17 */6 * * *", noRetry: () => {} },
      env,
      { waitUntil: (promise) => pending.push(promise) },
    );

    expect(pending).toHaveLength(1);
    expect(await pending[0]).toEqual({
      refreshed: false,
      reason: "access token still fresh",
    });
  });
});

describe("bindings", () => {
  test("the CODEX_AUTH KV namespace fits the store the handlers read", () => {
    expectTypeOf<KVNamespace>().toExtend<LoginStore>();
  });
});

describe("bundle sealing", () => {
  test("round-trips a login", async () => {
    const key = generateBundleKey();
    const login = storedLogin(HOUR_MS);

    expect(await openBundle(await sealBundle(login, key), key)).toEqual(login);
  });

  test("rejects a key that is not 32 bytes of base64", async () => {
    const login = storedLogin(HOUR_MS);

    expect(await rejectionMessage(sealBundle(login, "c2hvcnQ="))).toMatch(
      /32 random bytes/,
    );
    expect(await rejectionMessage(sealBundle(login, "not base64!"))).toMatch(
      /32 random bytes/,
    );
  });

  test("keeps the refresh token out of the sealed value", async () => {
    const sealed = await sealBundle(storedLogin(HOUR_MS), generateBundleKey());

    expect(sealed).not.toContain("refresh-1");
  });
});
