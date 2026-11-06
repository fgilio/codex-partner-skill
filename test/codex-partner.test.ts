import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isRecord } from "../skills/codex-partner/scripts/lib";
import { installFake } from "./fixtures/fake-bin";
import { makeJwt } from "./fixtures/jwt";

const HOUR_MS = 60 * 60 * 1000;

const repositoryDirectory = dirname(import.meta.dir);
const scriptsDirectory = join(
  repositoryDirectory,
  "skills",
  "codex-partner",
  "scripts",
);

interface Sandbox {
  root: string;
  project: string;
  codexHome: string;
  log: string;
  stateHome: string;
  env: Record<string, string>;
}

interface ScriptResult {
  status: number;
  stdout: string;
  stderr: string;
  json: unknown;
  error: string;
}

interface CodexCall {
  args: string[];
  stdin: string;
  cwd: string;
}

let sandbox: Sandbox;

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "codex-partner-test-"));
  const binDirectory = join(root, "bin");
  const project = join(root, "project");
  const codexHome = join(root, "codex-home");
  const log = join(root, "codex-calls.jsonl");
  const stateHome = join(root, "state");

  mkdirSync(binDirectory);
  mkdirSync(join(project, "src"), { recursive: true });
  installFake(binDirectory, "codex", "fake-codex.ts");
  Bun.spawnSync(["git", "init", "-q"], { cwd: project });

  return {
    root,
    project,
    codexHome,
    log,
    stateHome,
    env: {
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      HOME: root,
      CODEX_HOME: codexHome,
      XDG_STATE_HOME: stateHome,
      FAKE_CODEX_LOG: log,
    },
  };
}

async function runScript(
  script: string,
  args: string[],
  {
    cwd = sandbox.project,
    env = {},
    input = "",
  }: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): Promise<ScriptResult> {
  const child = Bun.spawn(
    [process.execPath, join(scriptsDirectory, script), ...args],
    {
      cwd,
      env: { ...sandbox.env, ...env },
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return {
    status,
    stdout,
    stderr,
    json: parseJson(stdout),
    error: stderr.trim(),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected a JSON object, got ${JSON.stringify(value)}`);
  }

  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`Expected a list of objects, got ${JSON.stringify(value)}`);
  }

  return value;
}

function isCodexCall(value: unknown): value is CodexCall {
  return (
    isRecord(value) &&
    Array.isArray(value.args) &&
    value.args.every((argument) => typeof argument === "string") &&
    typeof value.stdin === "string" &&
    typeof value.cwd === "string"
  );
}

/** The model and reasoning effort a Codex call ran with. */
function modelAndEffort(
  call: CodexCall,
): [string | undefined, string | undefined] {
  const modelFlag = call.args.indexOf("--model");
  const effort = call.args
    .map((argument) => /^model_reasoning_effort="(.*)"$/.exec(argument)?.[1])
    .find((value) => value !== undefined);

  return [modelFlag === -1 ? undefined : call.args[modelFlag + 1], effort];
}

function codexCalls(): CodexCall[] {
  if (!existsSync(sandbox.log)) {
    return [];
  }

  return readFileSync(sandbox.log, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const call: unknown = JSON.parse(line);

      if (!isCodexCall(call)) {
        throw new Error(`The fake codex logged ${line}`);
      }

      return call;
    });
}

function codexCall(index: number): CodexCall {
  const call = codexCalls()[index];

  if (call === undefined) {
    throw new Error(`Codex was called fewer than ${index + 1} times.`);
  }

  return call;
}

/** Fails with the script's stderr in the diff when it did not exit 0. */
function expectSuccess({ status, stderr }: ScriptResult): void {
  expect({ status, stderr }).toEqual({ status: 0, stderr });
}

function lockPath(threadId: string): string {
  return join(sandbox.stateHome, "codex-partner", "locks", `${threadId}.lock`);
}

function workerLogin(expiresInMs: number) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: makeJwt({ email: "user@example.com" }),
      access_token: makeJwt({
        exp: Math.floor((Date.now() + expiresInMs) / 1000),
      }),
      refresh_token: "",
      account_id: "account-1",
    },
    last_refresh: new Date().toISOString(),
  };
}

function git(...args: string[]): void {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ],
    { cwd: sandbox.project },
  );

  const stderr = result.stderr.toString();

  expect({ exitCode: result.exitCode, stderr }).toEqual({
    exitCode: 0,
    stderr,
  });
}

function commitFile(name: string): void {
  writeFileSync(join(sandbox.project, name), `${name}\n`);
  git("add", name);
  git("commit", "-q", "-m", `Add ${name}`);
}

function reviewTarget(result: ScriptResult): string | undefined {
  return /^Target: (.*)\n/.exec(result.stdout)?.[1];
}

function editFile(): void {
  writeFileSync(join(sandbox.project, "cart.js"), "export const total = 0;\n");
}

function authPath(): string {
  return join(sandbox.codexHome, "auth.json");
}
const storedTokens = () =>
  record(record(JSON.parse(readFileSync(authPath(), "utf8"))).tokens);

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

describe("the fake codex", () => {
  test("fails without --output-last-message, so a script that drops it fails too", () => {
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "fixtures", "fake-codex.ts"),
        "exec",
        "-",
      ],
      { cwd: sandbox.root, stdin: new TextEncoder().encode("Hi") },
    );

    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain(
      "fake codex: --output-last-message is missing",
    );
    expect(existsSync(join(sandbox.root, "exec"))).toBe(false);
  });
});

describe("codex-partner-ask", () => {
  test("sends the prompt on stdin to a read-only, ephemeral session on gpt-6.1-sol at medium effort", async () => {
    const result = await runScript("codex-partner-ask.ts", [
      "Does the loop stop?",
    ]);
    const call = codexCall(0);

    expectSuccess(result);
    expect(result.stdout).toBe("reply to: Does the loop stop?\n");
    expect(call.stdin).toBe("Does the loop stop?");
    expect(call.args.slice(-2)).toEqual(["--ephemeral", "-"]);
    expect(call.args).toContain('sandbox_mode="read-only"');
    expect(call.args).not.toContain("--sandbox");
    expect(modelAndEffort(call)).toEqual(["gpt-6.1-sol", "medium"]);
  });

  test("--model and --effort override the defaults, and partners run gpt-6.1-sol at high effort", async () => {
    await runScript("codex-partner-ask.ts", [
      "--model",
      "model-a",
      "--effort=low",
      "Hi",
    ]);
    await runScript("codex-partner-start.ts", ["review", "Hi"]);
    await runScript("codex-partner-say.ts", ["review", "Again"]);
    await runScript("codex-partner-say.ts", [
      "review",
      "--model",
      "model-b",
      "--effort",
      "minimal",
      "Once more",
    ]);

    expect(modelAndEffort(codexCall(0))).toEqual(["model-a", "low"]);
    expect(modelAndEffort(codexCall(1))).toEqual(["gpt-6.1-sol", "high"]);
    expect(modelAndEffort(codexCall(2))).toEqual(["gpt-6.1-sol", "high"]);
    expect(modelAndEffort(codexCall(3))).toEqual(["model-b", "minimal"]);
  });

  test("reads the prompt from stdin when it is -", async () => {
    const result = await runScript("codex-partner-ask.ts", ["-"], {
      input: "Line one\nLine two\n",
    });

    expectSuccess(result);
    expect(codexCall(0).stdin).toBe("Line one\nLine two\n");
  });

  test("--json prints the reply as JSON", async () => {
    const result = await runScript("codex-partner-ask.ts", ["--json", "Hi"]);

    expectSuccess(result);
    expect(result.json).toEqual({ reply: "reply to: Hi" });
  });

  test("rejects an empty prompt before calling Codex", async () => {
    const result = await runScript("codex-partner-ask.ts", ["-"], {
      input: "  \n",
    });

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/prompt is empty/);
    expect(codexCalls()).toEqual([]);
  });

  test("turns off the MCP servers with bare names in the Codex config", async () => {
    mkdirSync(sandbox.codexHome, { recursive: true });
    writeFileSync(
      join(sandbox.codexHome, "config.toml"),
      '[mcp_servers.sentry]\nurl = "x"\n\n[mcp_servers.linear.env]\nA = "1"\n\n[mcp_servers."quoted.name"]\nurl = "y"\n',
    );

    await runScript("codex-partner-ask.ts", ["Hi"]);
    await runScript("codex-partner-ask.ts", ["--mcp", "Hi"]);
    const withoutServers = codexCall(0);
    const withServers = codexCall(1);

    expect(withoutServers.args).toContain("mcp_servers.sentry.enabled=false");
    expect(withoutServers.args).toContain("mcp_servers.linear.enabled=false");
    expect(
      withoutServers.args.some((argument) => argument.includes("quoted")),
    ).toBe(false);
    expect(
      withServers.args.some((argument) => argument.startsWith("mcp_servers.")),
    ).toBe(false);
  });

  test("--write runs Codex in the workspace-write sandbox over the whole repository, with network off", async () => {
    await runScript("codex-partner-ask.ts", ["--write", "Hi"], {
      cwd: join(sandbox.project, "src"),
    });
    const call = codexCall(0);
    const sandboxFlag = call.args.indexOf("--sandbox");

    expect(call.args.slice(sandboxFlag, sandboxFlag + 8)).toEqual([
      "--sandbox",
      "workspace-write",
      "--add-dir",
      realpathSync(sandbox.project),
      "--config",
      'approval_policy="never"',
      "--config",
      "sandbox_workspace_write.network_access=false",
    ]);
    expect(call.args).not.toContain('sandbox_mode="read-only"');
  });

  test("surfaces the Codex error message when a turn fails", async () => {
    const result = await runScript("codex-partner-ask.ts", ["Hi"], {
      env: { FAKE_CODEX_MODE: "fail" },
    });

    expect(result.status).toBe(1);
    expect(result.error).toMatch(
      /exited with code 1 without a reply: model overloaded\.$/,
    );
  });

  test("tells the user how to install Codex when it is not on PATH", async () => {
    // Bun's own directory can hold a global `codex` install, so PATH gets a link to bun alone.
    const bunOnly = join(sandbox.root, "bun-only");
    mkdirSync(bunOnly);
    symlinkSync(process.execPath, join(bunOnly, "bun"));

    const result = await runScript("codex-partner-ask.ts", ["Hi"], {
      env: { PATH: bunOnly },
    });

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/npm install -g @openai\/codex/);
  });

  test("rejects an unknown option with the usage text", async () => {
    const result = await runScript("codex-partner-ask.ts", ["--loud", "Hi"]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/Unknown option --loud/);
    expect(result.error).toMatch(/Usage: codex-partner-ask\.ts/);
  });

  test("says a boolean option takes no value", async () => {
    const result = await runScript("codex-partner-ask.ts", [
      "--write=true",
      "Hi",
    ]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/The --write option takes no value/);
  });

  test("--help prints the usage on stdout and exits 0", async () => {
    const result = await runScript("codex-partner-ask.ts", ["--help"]);

    expectSuccess(result);
    expect(result.stdout).toStartWith("Usage: codex-partner-ask.ts");
    expect(codexCalls()).toEqual([]);
  });

  // Bun takes a `--` right after the script path as its own separator, so
  // the scripts see one only when another argument comes before it.
  test("passes a prompt that starts with a dash after --", async () => {
    const result = await runScript("codex-partner-ask.ts", [
      "--effort",
      "low",
      "--",
      "--not-a-flag",
    ]);

    expectSuccess(result);
    expect(codexCall(0).stdin).toBe("--not-a-flag");
  });

  test("takes a prompt that starts with a dash on stdin", async () => {
    const result = await runScript("codex-partner-ask.ts", ["-"], {
      input: "--not-a-flag",
    });

    expectSuccess(result);
    expect(codexCall(0).stdin).toBe("--not-a-flag");
  });

  // Pins the Bun behavior SKILL.md documents, so a Bun release that keeps
  // the leading `--` shows up here.
  test("reads a lone leading -- as Bun's own separator", async () => {
    const result = await runScript("codex-partner-ask.ts", [
      "--",
      "--not-a-flag",
    ]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/Unknown option --not-a-flag/);
    expect(codexCalls()).toEqual([]);
  });
});

describe("partners", () => {
  test("start saves the partner and say resumes the same Codex thread", async () => {
    const started = await runScript(
      "codex-partner-start.ts",
      ["review", "--json", "Remember the plan."],
      {
        env: { FAKE_CODEX_THREAD_ID: "thread-42" },
      },
    );
    const continued = await runScript("codex-partner-say.ts", [
      "review",
      "--json",
      "What was the plan?",
    ]);
    const startCall = codexCall(0);
    const sayCall = codexCall(1);

    expectSuccess(started);
    expect(started.json).toEqual({
      name: "review",
      thread_id: "thread-42",
      reply: "reply to: Remember the plan.",
    });
    expectSuccess(continued);
    expect(continued.json).toEqual({
      name: "review",
      thread_id: "thread-42",
      reply: "reply to: What was the plan?",
    });
    expect(startCall.args).not.toContain("--ephemeral");
    expect(sayCall.args.slice(-3)).toEqual(["resume", "thread-42", "-"]);
  });

  test("start and say print the reply as plain text", async () => {
    const started = await runScript("codex-partner-start.ts", [
      "review",
      "Remember the plan.",
    ]);
    const continued = await runScript("codex-partner-say.ts", [
      "review",
      "What was the plan?",
    ]);

    expectSuccess(started);
    expect(started.stdout).toBe("reply to: Remember the plan.\n");
    expectSuccess(continued);
    expect(continued.stdout).toBe("reply to: What was the plan?\n");
  });

  test("say runs Codex in the directory the partner started in", async () => {
    const startDirectory = join(sandbox.project, "src");

    await runScript("codex-partner-start.ts", ["review", "Hi"], {
      cwd: startDirectory,
    });
    await runScript("codex-partner-say.ts", ["review", "Again"], {
      cwd: sandbox.project,
    });
    const startCall = codexCall(0);
    const sayCall = codexCall(1);

    expect(startCall.cwd).toBe(sayCall.cwd);
    expect(sayCall.cwd).toMatch(/project\/src$/);
  });

  test("list shows the repository's partners, most recently used first", async () => {
    await runScript("codex-partner-start.ts", ["first", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-1" },
    });
    await runScript("codex-partner-start.ts", ["second", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-2" },
    });
    await runScript("codex-partner-say.ts", ["first", "Again"]);
    const result = await runScript("codex-partner-list.ts", []);

    expectSuccess(result);
    expect(records(result.json).map((session) => session.name)).toEqual([
      "first",
      "second",
    ]);
  });

  test("list keeps the partner store format on disk", async () => {
    await runScript("codex-partner-start.ts", ["review", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-3" },
    });
    const stored: unknown = JSON.parse(
      readFileSync(
        join(sandbox.stateHome, "codex-partner", "sessions.json"),
        "utf8",
      ),
    );
    const [partner] = records(stored);

    expect(Object.keys(record(partner))).toEqual([
      "name",
      "repository",
      "directory",
      "thread_id",
      "created_at",
      "last_used_at",
    ]);
    expect(record(partner).thread_id).toBe("thread-3");
    expect(
      statSync(join(sandbox.stateHome, "codex-partner", "sessions.json")).mode &
        0o777,
    ).toBe(0o600);
  });

  test("refuses a partner store that does not hold a list of partners", async () => {
    mkdirSync(join(sandbox.stateHome, "codex-partner"), { recursive: true });
    writeFileSync(
      join(sandbox.stateHome, "codex-partner", "sessions.json"),
      JSON.stringify([{ name: "review" }]),
    );

    const result = await runScript("codex-partner-list.ts", []);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(
      /sessions\.json does not hold a list of partners\. Move the file aside/,
    );
  });

  test("partner names are scoped to their repository, and list --all shows every one", async () => {
    const otherProject = join(sandbox.root, "other");

    mkdirSync(otherProject);
    Bun.spawnSync(["git", "init", "-q"], { cwd: otherProject });

    await runScript("codex-partner-start.ts", ["review", "Hi"]);
    const sameNameElsewhere = await runScript(
      "codex-partner-start.ts",
      ["review", "Hi"],
      { cwd: otherProject },
    );
    const local = await runScript("codex-partner-list.ts", [], {
      cwd: otherProject,
    });
    const everywhere = await runScript("codex-partner-list.ts", ["--all"]);

    expectSuccess(sameNameElsewhere);
    expect(records(local.json)).toHaveLength(1);
    expect(records(everywhere.json)).toHaveLength(2);
  });

  test("start refuses a name that already exists in the repository", async () => {
    await runScript("codex-partner-start.ts", ["review", "Hi"]);
    const result = await runScript("codex-partner-start.ts", [
      "review",
      "Hi again",
    ]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/already exists/);
    expect(result.error).toMatch(/codex-partner-say\.ts review/);
    expect(codexCalls()).toHaveLength(1);
  });

  test("start fails when Codex reports no thread id", async () => {
    const result = await runScript("codex-partner-start.ts", ["review", "Hi"], {
      env: { FAKE_CODEX_MODE: "no-thread" },
    });
    const list = await runScript("codex-partner-list.ts", []);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/without reporting a thread id/);
    expect(list.json).toEqual([]);
  });

  test("start refuses to replace a same-name partner saved while Codex answered", async () => {
    const [slow, fast] = await Promise.all([
      runScript("codex-partner-start.ts", ["review", "Slow"], {
        env: {
          FAKE_CODEX_THREAD_ID: "thread-slow",
          FAKE_CODEX_DELAY_MS: "800",
        },
      }),
      runScript("codex-partner-start.ts", ["review", "Fast"], {
        env: { FAKE_CODEX_THREAD_ID: "thread-fast" },
      }),
    ]);
    const list = await runScript("codex-partner-list.ts", []);

    expectSuccess(fast);
    expect(slow.status).toBe(1);
    expect(slow.error).toMatch(
      /was saved in .* while Codex answered\. This reply is on Codex thread thread-slow/,
    );
    expect(records(list.json).map((partner) => partner.thread_id)).toEqual([
      "thread-fast",
    ]);
  });

  test("say names the command that starts an unknown partner", async () => {
    const result = await runScript("codex-partner-say.ts", ["missing", "Hi"]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/codex-partner-start\.ts missing/);
  });

  test("say refuses while another live call holds the partner", async () => {
    await runScript("codex-partner-start.ts", ["review", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-7" },
    });
    mkdirSync(dirname(lockPath("thread-7")), { recursive: true });
    writeFileSync(lockPath("thread-7"), String(process.pid));

    const result = await runScript("codex-partner-say.ts", ["review", "Again"]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/still answering another message/);
  });

  test("say replaces a lock left behind by a process that exited", async () => {
    const exited = Bun.spawnSync([
      process.execPath,
      "-e",
      "process.stdout.write(String(process.pid))",
    ]);

    await runScript("codex-partner-start.ts", ["review", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-8" },
    });
    mkdirSync(dirname(lockPath("thread-8")), { recursive: true });
    writeFileSync(lockPath("thread-8"), exited.stdout.toString());

    const result = await runScript("codex-partner-say.ts", ["review", "Again"]);

    expectSuccess(result);
    expect(existsSync(lockPath("thread-8"))).toBe(false);
  });

  test("forget removes the partner so the name can start over", async () => {
    await runScript("codex-partner-start.ts", ["review", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-9" },
    });
    const forgotten = await runScript("codex-partner-forget.ts", ["review"]);
    const restarted = await runScript("codex-partner-start.ts", [
      "review",
      "Hi",
    ]);

    expect(forgotten.json).toEqual({
      name: "review",
      thread_id: "thread-9",
      forgotten: true,
    });
    expectSuccess(restarted);
  });

  test("forget names the list command for an unknown partner", async () => {
    const result = await runScript("codex-partner-forget.ts", ["missing"]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(
      /No partner named "missing" exists in .*\. List them with codex-partner-list\.ts\./,
    );
  });

  test("rejects a partner name with spaces or slashes", async () => {
    const result = await runScript("codex-partner-start.ts", [
      "my/partner",
      "Hi",
    ]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/name "my\/partner" is invalid/);
  });
});

describe("codex-partner-review", () => {
  test("reviews the uncommitted changes in a read-only, ephemeral session on gpt-6.1-sol at high effort", async () => {
    editFile();

    const result = await runScript("codex-partner-review.ts", []);
    const call = codexCall(0);

    expectSuccess(result);
    expect(reviewTarget(result)).toBe("uncommitted changes");
    expect(call.args.slice(-3)).toEqual([
      "--ephemeral",
      "review",
      "--uncommitted",
    ]);
    expect(call.args).toContain('sandbox_mode="read-only"');
    expect(modelAndEffort(call)).toEqual(["gpt-6.1-sol", "high"]);
  });

  test("reviews the branch against origin/HEAD when the working tree is clean", async () => {
    git("checkout", "-q", "-b", "feature");
    commitFile("base.txt");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    commitFile("feature.txt");

    const result = await runScript("codex-partner-review.ts", []);

    expectSuccess(result);
    expect(reviewTarget(result)).toBe("changes against origin/main");
    expect(codexCall(0).args.slice(-3)).toEqual([
      "review",
      "--base",
      "origin/main",
    ]);
  });

  test("falls back to a local main branch when origin/HEAD is missing or points at a deleted branch", async () => {
    git("checkout", "-q", "-b", "feature");
    commitFile("base.txt");
    git("branch", "main");
    commitFile("feature.txt");

    const missing = await runScript("codex-partner-review.ts", []);

    git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );

    const dangling = await runScript("codex-partner-review.ts", []);

    expectSuccess(missing);
    expect(reviewTarget(missing)).toBe("changes against main");
    expectSuccess(dangling);
    expect(reviewTarget(dangling)).toBe("changes against main");
  });

  test("counts untracked files even when git status hides them", async () => {
    git("checkout", "-q", "-b", "main");
    commitFile("base.txt");
    git("config", "status.showUntrackedFiles", "no");
    editFile();

    const result = await runScript("codex-partner-review.ts", []);

    expectSuccess(result);
    expect(reviewTarget(result)).toBe("uncommitted changes");
  });

  test("refuses when the tree is clean and HEAD has no commits the default branch lacks", async () => {
    git("checkout", "-q", "-b", "main");
    commitFile("base.txt");

    const result = await runScript("codex-partner-review.ts", []);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/Nothing to review/);
    expect(codexCalls()).toEqual([]);
  });

  test("passes --base and --commit through once git finds them", async () => {
    git("checkout", "-q", "-b", "feature");
    commitFile("base.txt");
    git("branch", "main");
    commitFile("feature.txt");

    const base = await runScript("codex-partner-review.ts", ["--base", "main"]);
    const commit = await runScript("codex-partner-review.ts", [
      "--commit=HEAD",
    ]);
    const missing = await runScript("codex-partner-review.ts", [
      "--base",
      "release",
    ]);
    const missingCommit = await runScript("codex-partner-review.ts", [
      "--commit",
      "0000000",
    ]);

    expect(reviewTarget(base)).toBe("changes against main");
    expect(codexCall(0).args.slice(-3)).toEqual(["review", "--base", "main"]);
    expect(reviewTarget(commit)).toBe("commit HEAD");
    expect(codexCall(1).args.slice(-3)).toEqual(["review", "--commit", "HEAD"]);
    expect(missing.status).toBe(1);
    expect(missing.error).toMatch(/Unable to find the base branch "release"/);
    expect(missingCommit.status).toBe(1);
    expect(missingCommit.error).toMatch(/Unable to find the commit "0000000"/);
    expect(codexCalls()).toHaveLength(2);
  });

  test("sends instructions on stdin, and refuses them alongside a target", async () => {
    const result = await runScript("codex-partner-review.ts", ["-"], {
      input: "Check the auth flow for races.",
    });
    const conflict = await runScript("codex-partner-review.ts", [
      "--base",
      "main",
      "Focus on auth.",
    ]);
    const call = codexCall(0);

    expectSuccess(result);
    expect(reviewTarget(result)).toBe("custom instructions");
    expect(call.args.slice(-2)).toEqual(["review", "-"]);
    expect(call.stdin).toBe("Check the auth flow for races.");
    expect(conflict.status).toBe(1);
    expect(conflict.error).toMatch(/or follows instructions, not both/);
    expect(codexCalls()).toHaveLength(1);
  });

  test("--as keeps the review as a partner that say continues", async () => {
    editFile();

    const reviewed = await runScript(
      "codex-partner-review.ts",
      ["--as", "cart", "--effort", "xhigh", "--json"],
      { env: { FAKE_CODEX_THREAD_ID: "thread-7" } },
    );
    const continued = await runScript("codex-partner-say.ts", [
      "cart",
      "I fixed P1. Check again.",
    ]);
    const reviewCall = codexCall(0);
    const sayCall = codexCall(1);

    expectSuccess(reviewed);
    expect(reviewed.json).toEqual({
      name: "cart",
      thread_id: "thread-7",
      target: "uncommitted changes",
      reply: "review of: --uncommitted",
    });
    expect(reviewCall.args).not.toContain("--ephemeral");
    expect(reviewCall.args).toContain('model_reasoning_effort="xhigh"');
    expectSuccess(continued);
    expect(sayCall.args.slice(-3)).toEqual(["resume", "thread-7", "-"]);
  });

  test("prints the target line, then the findings, with or without --as", async () => {
    editFile();

    const [ephemeral, kept] = await Promise.all([
      runScript("codex-partner-review.ts", []),
      runScript("codex-partner-review.ts", ["--as", "cart"]),
    ]);

    expectSuccess(ephemeral);
    expect(ephemeral.stdout).toBe(
      "Target: uncommitted changes\n\nreview of: --uncommitted\n",
    );
    expectSuccess(kept);
    expect(kept.stdout).toBe(ephemeral.stdout);
  });

  test("--as refuses a partner name that already exists, before calling Codex", async () => {
    await runScript("codex-partner-start.ts", ["cart", "Hi"]);
    editFile();

    const result = await runScript("codex-partner-review.ts", ["--as", "cart"]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/already exists/);
    expect(codexCalls()).toHaveLength(1);
  });

  test("refuses --write, --base with --commit, and a target outside a git repository", async () => {
    const write = await runScript("codex-partner-review.ts", ["--write"]);
    const both = await runScript("codex-partner-review.ts", [
      "--base",
      "main",
      "--commit",
      "HEAD",
    ]);
    const outside = await runScript("codex-partner-review.ts", [], {
      cwd: sandbox.root,
    });

    expect(write.error).toMatch(/Unknown option --write/);
    expect(both.error).toMatch(/Pass --base or --commit, not both/);
    expect(outside.error).toMatch(/is not inside a git repository/);
    expect(codexCalls()).toEqual([]);
  });
});

describe("cloud auth", () => {
  let server: Server<undefined>;
  let tokenUrl: string;
  let requests: { url: string; authorization: string | null }[];
  let respond: () => [number, unknown];

  beforeEach(() => {
    requests = [];
    respond = () => [500, { error: "No response was set." }];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        requests.push({
          url: new URL(request.url).pathname,
          authorization: request.headers.get("Authorization"),
        });
        const [status, body] = respond();

        return Response.json(body, { status });
      },
    });
    tokenUrl = `http://127.0.0.1:${server.port}/auth.json`;
  });

  afterEach(async () => {
    await server.stop(true);
  });

  test("writes the worker login with mode 600 before calling Codex", async () => {
    respond = () => [200, workerLogin(10 * 24 * HOUR_MS)];

    const result = await runScript("codex-partner-ask.ts", ["Hi"], {
      env: { CODEX_TOKEN_URL: tokenUrl, CODEX_TOKEN_BEARER: "serve-secret" },
    });

    expectSuccess(result);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer serve-secret");
    expect(storedTokens().account_id).toBe("account-1");
    expect(statSync(authPath()).mode & 0o777).toBe(0o600);
  });

  test("reuses a stored worker login until it is about to expire", async () => {
    respond = () => [200, workerLogin(10 * 24 * HOUR_MS)];

    const fetched = await runScript("codex-partner-auth.ts", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });
    const reused = await runScript("codex-partner-auth.ts", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    expect(requests).toHaveLength(1);
    expect(record(fetched.json).fetched).toBe(true);
    expect(record(reused.json).source).toBe("token-worker");
    expect(record(reused.json).fetched).toBe(false);
    expect(record(reused.json).access_expires_at).toBe(
      record(fetched.json).access_expires_at,
    );
    expect(String(record(reused.json).access_expires_at)).toMatch(
      /^\d{4}-\d\d-\d\dT/,
    );
  });

  test("fetches a new login when the stored one expires within the hour", async () => {
    mkdirSync(sandbox.codexHome, { recursive: true });
    writeFileSync(authPath(), JSON.stringify(workerLogin(HOUR_MS / 2)));
    respond = () => [200, workerLogin(10 * 24 * HOUR_MS)];

    const result = await runScript("codex-partner-auth.ts", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    expect(record(result.json).fetched).toBe(true);
    expect(requests).toHaveLength(1);
  });

  test("never replaces a Codex login that carries a refresh token", async () => {
    const ownLogin = workerLogin(HOUR_MS);
    ownLogin.tokens.refresh_token = "real-refresh-token";
    mkdirSync(sandbox.codexHome, { recursive: true });
    writeFileSync(authPath(), JSON.stringify(ownLogin));

    const result = await runScript("codex-partner-auth.ts", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    expect(result.json).toEqual({ source: "codex-login" });
    expect(requests).toHaveLength(0);
    expect(storedTokens().refresh_token).toBe("real-refresh-token");
  });

  test("names the missing CODEX_TOKEN_BEARER when the worker answers 401", async () => {
    respond = () => [401, { error: "Missing or invalid bearer token." }];

    const result = await runScript("codex-partner-ask.ts", ["Hi"], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/CODEX_TOKEN_BEARER is unset/);
    expect(result.error).toMatch(
      /network secret for 127\.0\.0\.1:\d+ exposed as CODEX_TOKEN_BEARER/,
    );
    expect(codexCalls()).toEqual([]);
  });

  test("names the rejected serve token when the worker answers 401 to a bearer", async () => {
    respond = () => [401, { error: "Missing or invalid bearer token." }];

    const result = await runScript("codex-partner-ask.ts", ["Hi"], {
      env: { CODEX_TOKEN_URL: tokenUrl, CODEX_TOKEN_BEARER: "stale-secret" },
    });

    expect(result.status).toBe(1);
    expect(requests[0]?.authorization).toBe("Bearer stale-secret");
    expect(result.error).toMatch(
      /rejected the serve token in CODEX_TOKEN_BEARER/,
    );
    expect(result.error).toMatch(
      /network secret for 127\.0\.0\.1:\d+ holds the worker's SERVE_TOKEN/,
    );
    expect(result.error).not.toMatch(/stale-secret/);
    expect(codexCalls()).toEqual([]);
  });

  test("relays the worker's error message for other failures", async () => {
    respond = () => [503, { error: "No Codex login is stored." }];

    const result = await runScript("codex-partner-auth.ts", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/answered 503: No Codex login is stored/);
  });

  test("rejects a worker response that is not a Codex login", async () => {
    respond = () => [200, { hello: "world" }];

    const result = await runScript("codex-partner-auth.ts", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/not a Codex login/);
    expect(existsSync(authPath())).toBe(false);
  });

  test("names a CODEX_TOKEN_URL that is not a URL", async () => {
    const result = await runScript("codex-partner-auth.ts", [], {
      env: { CODEX_TOKEN_URL: "not a url" },
    });

    expect(result.status).toBe(1);
    expect(result.error).toMatch(
      /CODEX_TOKEN_URL is "not a url", which is not a valid URL\./,
    );
  });

  test("--quiet prints nothing and exits 0 even when the worker fails", async () => {
    respond = () => [503, { error: "No Codex login is stored." }];

    const result = await runScript("codex-partner-auth.ts", ["--quiet"], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.error).toMatch(/codex-partner: .*No Codex login is stored/);
  });

  test("--quiet exits 0 when the stored login does not parse", async () => {
    mkdirSync(sandbox.codexHome, { recursive: true });
    writeFileSync(authPath(), "{ not json");

    const result = await runScript("codex-partner-auth.ts", ["--quiet"], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.error).toMatch(/codex-partner: Unable to parse .*auth\.json/);
  });

  test("reports the codex-login source when CODEX_TOKEN_URL is unset", async () => {
    const result = await runScript("codex-partner-auth.ts", []);

    expect(result.json).toEqual({ source: "codex-login" });
  });

  test("auth rejects positional arguments", async () => {
    const result = await runScript("codex-partner-auth.ts", ["now"]);

    expect(result.status).toBe(1);
    expect(result.error).toMatch(/takes no arguments/);
  });
});
