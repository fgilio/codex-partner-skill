import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isRecord } from "../../skills/codex-partner/scripts/lib";
import { installFake } from "../../test/fixtures/fake-bin";
import { makeJwt } from "../../test/fixtures/jwt";
import { rejectionMessage } from "../../test/fixtures/rejection";
import { openBundle } from "../src/bundle";
import { BUNDLE_KV_KEY, STATUS_KV_KEY } from "../src/index";
import {
  PINNED_WRANGLER,
  WORKER_DIRECTORY,
  assertDedicatedLogin,
  commandRunner,
  readLogin,
  storeInWorker,
} from "../scripts/seed";
import type { CommandRunner } from "../scripts/seed";
import { fetchStatus } from "../scripts/status";

const HOUR_MS = 60 * 60 * 1000;
const scriptsDirectory = join(import.meta.dir, "..", "scripts");

interface WranglerCall {
  args: string[];
  stdin: string;
  cwd: string;
}

let root: string;
let binDirectory: string;
let wranglerLog: string;

function dedicatedLogin(expiresInMs = 10 * 24 * HOUR_MS) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: makeJwt({ email: "worker@example.com" }),
      access_token: makeJwt({
        exp: Math.floor((Date.now() + expiresInMs) / 1000),
      }),
      refresh_token: "refresh-1",
      account_id: "account-1",
    },
    last_refresh: "2026-01-01T00:00:00.000Z",
  };
}

function writeJson(name: string, value: unknown): string {
  const path = join(root, name);

  writeFileSync(path, JSON.stringify(value));

  return path;
}

function isWranglerCall(value: unknown): value is WranglerCall {
  return (
    isRecord(value) &&
    Array.isArray(value.args) &&
    value.args.every((argument) => typeof argument === "string") &&
    typeof value.stdin === "string" &&
    typeof value.cwd === "string"
  );
}

function wranglerCalls(): WranglerCall[] {
  if (!existsSync(wranglerLog)) {
    return [];
  }

  return readFileSync(wranglerLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const call: unknown = JSON.parse(line);

      if (!isWranglerCall(call)) {
        throw new Error(`The fake wrangler logged ${line}`);
      }

      return call;
    });
}

/** Records each command instead of running it. */
function recordingRunner() {
  const calls: { command: string; args: string[]; input?: string }[] = [];
  const run: CommandRunner = (command, args, input) => {
    calls.push({ command, args, ...(input === undefined ? {} : { input }) });
  };

  return { calls, run };
}

async function runScript(
  script: string,
  args: string[],
  env: Record<string, string>,
) {
  const child = Bun.spawn(
    [process.execPath, join(scriptsDirectory, script), ...args],
    {
      cwd: root,
      env: {
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        HOME: root,
        CODEX_HOME: join(root, "codex-home"),
        FAKE_WRANGLER_LOG: wranglerLog,
        CODEX_TOKEN_WRANGLER: join(binDirectory, "wrangler"),
        ...env,
      },
      stdin: new Blob([""]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { status, stdout, error: stderr.trim() };
}

const fakeWranglerEnv = () => ({
  PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
  FAKE_WRANGLER_LOG: wranglerLog,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-token-scripts-test-"));
  binDirectory = join(root, "bin");
  wranglerLog = join(root, "wrangler-calls.jsonl");
  mkdirSync(binDirectory);
  installFake(binDirectory, "wrangler", "fake-wrangler.ts");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("seed: readLogin", () => {
  test("accepts a ChatGPT login with a refresh token and a readable expiry", () => {
    const login = dedicatedLogin();

    expect(readLogin(writeJson("auth.json", login))).toEqual(login);
  });

  test("names codex login when the file is missing", () => {
    expect(() => readLogin(join(root, "missing.json"))).toThrow(
      /No Codex login found at .*missing\.json\. Sign in with `codex login`/,
    );
  });

  test("refuses a file that is not JSON", () => {
    const path = join(root, "auth.json");
    writeFileSync(path, "{ not json");

    expect(() => readLogin(path)).toThrow(
      /Unable to parse .*auth\.json as JSON/,
    );
  });

  test("refuses an API key login and a login without a refresh token", () => {
    const apiKey = writeJson("api-key.json", {
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-test",
    });
    const workerIssued = dedicatedLogin();
    workerIssued.tokens.refresh_token = "";

    expect(() => readLogin(apiKey)).toThrow(
      /is not a ChatGPT login with a refresh token/,
    );
    expect(() => readLogin(writeJson("worker.json", workerIssued))).toThrow(
      /is not a ChatGPT login with a refresh token/,
    );
  });

  test("refuses an access token with no readable expiry", () => {
    const login = dedicatedLogin();
    login.tokens.access_token = "not-a-jwt";

    expect(() => readLogin(writeJson("auth.json", login))).toThrow(
      /holds an access token with no readable expiry/,
    );
  });
});

describe("seed: assertDedicatedLogin", () => {
  test("refuses the login this machine refreshes, also through a link", () => {
    const shared = writeJson("auth.json", dedicatedLogin());
    const linked = join(root, "linked.json");
    symlinkSync(shared, linked);

    expect(() => assertDedicatedLogin(shared, shared)).toThrow(
      /is the Codex login this machine refreshes/,
    );
    expect(() => assertDedicatedLogin(linked, shared)).toThrow(
      /is the Codex login this machine refreshes/,
    );
  });

  test("accepts another login, and any login when the machine has none", () => {
    const dedicated = writeJson("dedicated.json", dedicatedLogin());
    const shared = writeJson("auth.json", dedicatedLogin());

    expect(() => assertDedicatedLogin(dedicated, shared)).not.toThrow();
    expect(() =>
      assertDedicatedLogin(dedicated, join(root, "missing.json")),
    ).not.toThrow();
  });
});

describe("seed: storeInWorker", () => {
  test("stores the sealed login, the key, and a fresh status through wrangler", async () => {
    const login = dedicatedLogin();
    const { calls, run } = recordingRunner();
    const now = new Date("2026-11-01T12:00:00.000Z");

    const summary = await storeInWorker({ login, scratch: root, run, now });
    const sealedPath = join(root, "bundle.json");
    const [bundle, secret, status] = calls;

    expect(calls).toHaveLength(3);
    expect(bundle).toEqual({
      command: PINNED_WRANGLER,
      args: [
        "kv",
        "key",
        "put",
        BUNDLE_KV_KEY,
        "--binding",
        "CODEX_AUTH",
        "--remote",
        "--path",
        sealedPath,
      ],
    });
    expect(secret?.command).toBe(PINNED_WRANGLER);
    expect(secret?.args).toEqual(["secret", "put", "BUNDLE_KEY"]);
    expect(
      await openBundle(readFileSync(sealedPath, "utf8"), secret?.input),
    ).toEqual(login);
    expect(status).toEqual({
      command: PINNED_WRANGLER,
      args: [
        "kv",
        "key",
        "put",
        STATUS_KV_KEY,
        JSON.stringify({
          seeded_at: "2026-11-01T12:00:00.000Z",
          last_error: null,
        }),
        "--binding",
        "CODEX_AUTH",
        "--remote",
      ],
    });
    expect(summary).toEqual({
      seeded: true,
      account_id: "account-1",
      access_expires_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
  });

  test("keeps the sealed file private and generates a new key each run", async () => {
    const first = recordingRunner();
    const second = recordingRunner();

    await storeInWorker({
      login: dedicatedLogin(),
      scratch: root,
      run: first.run,
    });
    const mode = Bun.file(join(root, "bundle.json"));
    await storeInWorker({
      login: dedicatedLogin(),
      scratch: root,
      run: second.run,
    });

    expect((await mode.stat()).mode & 0o777).toBe(0o600);
    expect(first.calls[1]?.input).not.toBe(second.calls[1]?.input);
    expect(first.calls[1]?.input).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  test("stops at the first wrangler command that fails", async () => {
    let calls = 0;
    const run: CommandRunner = () => {
      calls++;
      throw new Error("wrangler kv key failed");
    };

    expect(
      await rejectionMessage(
        storeInWorker({ login: dedicatedLogin(), scratch: root, run }),
      ),
    ).toMatch(/wrangler kv key failed/);
    expect(calls).toBe(1);
  });
});

describe("seed: commandRunner", () => {
  test("runs in the worker directory and passes the input on stdin", () => {
    commandRunner(WORKER_DIRECTORY, fakeWranglerEnv())(
      "wrangler",
      ["secret", "put", "BUNDLE_KEY"],
      "key-value",
    );

    expect(wranglerCalls()).toEqual([
      {
        args: ["secret", "put", "BUNDLE_KEY"],
        stdin: "key-value",
        cwd: WORKER_DIRECTORY,
      },
    ]);
  });

  test("names the command and its first three arguments when it fails", () => {
    const run = commandRunner(root, {
      ...fakeWranglerEnv(),
      FAKE_WRANGLER_FAIL: "kv",
    });

    expect(() =>
      run("wrangler", ["kv", "key", "put", "bundle", "--remote"]),
    ).toThrow("wrangler kv key put failed: Authentication error [code: 10000]");
  });

  test("names bun install when the pinned wrangler is missing", () => {
    const run = commandRunner(root, fakeWranglerEnv());

    expect(() =>
      run(join(root, "node_modules", ".bin", "wrangler"), []),
    ).toThrow(
      /^Unable to find .*\/node_modules\/\.bin\/wrangler\. Run `bun install` at the repository root/,
    );
  });

  test("names a command that is not on PATH", () => {
    const run = commandRunner(root, { PATH: join(root, "empty") });

    expect(() => run("wrangler", ["whoami"])).toThrow(
      "Unable to find wrangler on PATH. Install it, then run this script again.",
    );
  });
});

describe("the pinned wrangler", () => {
  test("is the version package.json pins, installed by bun install", async () => {
    const manifest: unknown = await Bun.file(
      join(WORKER_DIRECTORY, "..", "package.json"),
    ).json();
    const devDependencies = isRecord(manifest)
      ? manifest.devDependencies
      : undefined;
    const pinned = isRecord(devDependencies)
      ? devDependencies.wrangler
      : undefined;
    const version = Bun.spawnSync([PINNED_WRANGLER, "--version"], {
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });

    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version.stdout.toString().trim()).toBe(String(pinned));
  });
});

describe("seed.ts", () => {
  test("seeds the worker from --auth through wrangler", async () => {
    const auth = writeJson("dedicated.json", dedicatedLogin());

    const result = await runScript("seed.ts", ["--auth", auth], {
      CLOUDFLARE_ACCOUNT_ID: "account-id",
    });
    const calls = wranglerCalls();

    expect({ status: result.status, error: result.error }).toEqual({
      status: 0,
      error: "",
    });
    expect(JSON.parse(result.stdout)).toEqual({
      seeded: true,
      account_id: "account-1",
      access_expires_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(calls.map((call) => call.args.slice(0, 4))).toEqual([
      ["kv", "key", "put", BUNDLE_KV_KEY],
      ["secret", "put", "BUNDLE_KEY"],
      ["kv", "key", "put", STATUS_KV_KEY],
    ]);
    expect(calls.every((call) => call.cwd === WORKER_DIRECTORY)).toBe(true);
    expect(calls[1]?.stdin).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  test("refuses the Codex login this machine refreshes", async () => {
    mkdirSync(join(root, "codex-home"));
    const shared = join(root, "codex-home", "auth.json");
    writeFileSync(shared, JSON.stringify(dedicatedLogin()));

    const result = await runScript("seed.ts", ["--auth", shared], {
      CLOUDFLARE_ACCOUNT_ID: "account-id",
    });

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/is the Codex login this machine refreshes/);
    expect(wranglerCalls()).toEqual([]);
  });

  test("relays a failed wrangler call", async () => {
    const auth = writeJson("dedicated.json", dedicatedLogin());

    const result = await runScript("seed.ts", ["--auth", auth], {
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      FAKE_WRANGLER_FAIL: "secret",
    });

    expect(result.status).toBe(1);
    expect(result.error).toBe(
      "wrangler secret put BUNDLE_KEY failed: Authentication error [code: 10000]",
    );
  });

  test("needs CLOUDFLARE_ACCOUNT_ID and takes no positional arguments", async () => {
    const withoutAccount = await runScript("seed.ts", [], {});
    const positional = await runScript("seed.ts", ["now"], {
      CLOUDFLARE_ACCOUNT_ID: "account-id",
    });

    expect(withoutAccount.status).toBe(1);
    expect(withoutAccount.error).toMatch(/Set CLOUDFLARE_ACCOUNT_ID/);
    expect(positional.status).toBe(1);
    expect(positional.error).toMatch(/seed\.ts takes no positional arguments/);
    expect(wranglerCalls()).toEqual([]);
  });
});

describe("status", () => {
  let server: Server<undefined>;
  let tokenUrl: string;
  let requests: { path: string; authorization: string | null }[];
  let respond: () => Response;

  beforeEach(() => {
    requests = [];
    respond = () => Response.json({ access_expires_at: null }, { status: 200 });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("Authorization"),
        });

        return respond();
      },
    });
    tokenUrl = `http://127.0.0.1:${server.port}/auth.json`;
  });

  afterEach(async () => {
    await server.stop(true);
  });

  test("reads /status with the serve token and returns the body", async () => {
    const status = {
      access_expires_at: "2026-11-10T00:00:00.000Z",
      last_error: null,
    };
    respond = () => Response.json(status);

    const body = await fetchStatus({
      CODEX_TOKEN_URL: tokenUrl,
      CODEX_TOKEN_BEARER: "serve-secret",
    });

    expect(body).toEqual(status);
    expect(requests).toEqual([
      { path: "/status", authorization: "Bearer serve-secret" },
    ]);
  });

  test("names the variable that is missing", async () => {
    expect(
      await rejectionMessage(
        fetchStatus({ CODEX_TOKEN_BEARER: "serve-secret" }),
      ),
    ).toMatch(/Set CODEX_TOKEN_URL to the worker's \/auth\.json URL/);
    expect(
      await rejectionMessage(fetchStatus({ CODEX_TOKEN_URL: tokenUrl })),
    ).toMatch(/Set CODEX_TOKEN_BEARER to the worker's serve token/);
    expect(requests).toEqual([]);
  });

  test("relays the worker's error, or says it sent none", async () => {
    const env = { CODEX_TOKEN_URL: tokenUrl, CODEX_TOKEN_BEARER: "wrong" };

    respond = () =>
      Response.json(
        { error: "Missing or invalid serve token." },
        { status: 401 },
      );
    expect(await rejectionMessage(fetchStatus(env))).toMatch(
      "The token worker answered 401: Missing or invalid serve token.",
    );

    respond = () => new Response("Bad gateway", { status: 502 });
    expect(await rejectionMessage(fetchStatus(env))).toMatch(
      "The token worker answered 502: no error message",
    );
  });

  test("status.ts prints the worker's status as JSON", async () => {
    respond = () => Response.json({ last_error: null });

    const result = await runScript("status.ts", [], {
      CODEX_TOKEN_URL: tokenUrl,
      CODEX_TOKEN_BEARER: "serve-secret",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{\n  "last_error": null\n}\n');
  });

  test("refuses a 200 whose body is not the worker's JSON", async () => {
    const page = `<!doctype html><title>Sign in</title>${"x".repeat(100)}`;
    respond = () =>
      new Response(page, { headers: { "Content-Type": "text/html" } });

    const message = await rejectionMessage(
      fetchStatus({ CODEX_TOKEN_URL: tokenUrl, CODEX_TOKEN_BEARER: "secret" }),
    );

    expect(message).toBe(
      `${new URL("/status", tokenUrl).href} answered 200 with a body that is not the worker's JSON status: ${JSON.stringify(page.slice(0, 80))}. Check that CODEX_TOKEN_URL points at the token worker.`,
    );
  });

  test("status.ts exits 1 on a 200 that is not JSON, and 0 on one that is", async () => {
    const env = { CODEX_TOKEN_URL: tokenUrl, CODEX_TOKEN_BEARER: "secret" };

    respond = () => new Response("Proxy says hello");
    const proxied = await runScript("status.ts", [], env);

    respond = () => Response.json({ last_error: null });
    const healthy = await runScript("status.ts", [], env);

    expect(proxied.status).toBe(1);
    expect(proxied.stdout).toBe("");
    expect(proxied.error).toMatch(
      /\/status answered 200 with a body that is not the worker's JSON status: "Proxy says hello"/,
    );
    expect(healthy.status).toBe(0);
    expect(healthy.stdout).toBe('{\n  "last_error": null\n}\n');
  });

  test("status.ts exits 1 with the fix when a variable is missing", async () => {
    const result = await runScript("status.ts", [], {
      CODEX_TOKEN_BEARER: "serve-secret",
    });

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/^Set CODEX_TOKEN_URL/);
    expect(result.error).toMatch(/bun token-worker\/scripts\/status\.ts/);
  });
});
