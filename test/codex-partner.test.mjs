import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeJwt } from "./fixtures/jwt.mjs";

const HOUR_MS = 60 * 60 * 1000;

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptsDirectory = join(
  repositoryDirectory,
  "skills",
  "codex-partner",
  "scripts",
);
const fakeCodexSource = join(
  repositoryDirectory,
  "test",
  "fixtures",
  "fake-codex.mjs",
);

let sandbox;

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), "codex-partner-test-"));
  const binDirectory = join(root, "bin");
  const project = join(root, "project");
  const codexHome = join(root, "codex-home");
  const log = join(root, "codex-calls.jsonl");

  mkdirSync(binDirectory);
  mkdirSync(join(project, "src"), { recursive: true });
  copyFileSync(fakeCodexSource, join(binDirectory, "codex"));
  chmodSync(join(binDirectory, "codex"), 0o755);
  spawnSync("git", ["init", "-q"], { cwd: project });

  return {
    root,
    project,
    codexHome,
    log,
    env: {
      PATH: `${binDirectory}:${process.env.PATH}`,
      HOME: root,
      CODEX_HOME: codexHome,
      XDG_STATE_HOME: join(root, "state"),
      FAKE_CODEX_LOG: log,
    },
  };
}

function runScript(
  script,
  args,
  { cwd = sandbox.project, env = {}, input } = {},
) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(scriptsDirectory, script), ...args],
      { cwd, env: { ...sandbox.env, ...env } },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) =>
      resolve({
        status,
        stdout,
        stderr,
        json: parseJson(stdout),
        error: stderr.trim(),
      }),
    );
    child.stdin.end(input ?? "");
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function codexCalls() {
  return existsSync(sandbox.log)
    ? readFileSync(sandbox.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

function lockPath(threadId) {
  return join(
    sandbox.env.XDG_STATE_HOME,
    "codex-partner",
    "locks",
    `${threadId}.lock`,
  );
}

function workerLogin(expiresInMs) {
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

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

describe("codex-partner-ask", () => {
  test("sends the prompt on stdin to a read-only, ephemeral session at low effort", async () => {
    const result = await runScript("codex-partner-ask.mjs", [
      "Does the loop stop?",
    ]);
    const [call] = codexCalls();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "reply to: Does the loop stop?\n");
    assert.equal(call.stdin, "Does the loop stop?");
    assert.deepEqual(call.args.slice(-2), ["--ephemeral", "-"]);
    assert.ok(call.args.includes('sandbox_mode="read-only"'));
    assert.ok(call.args.includes('model_reasoning_effort="low"'));
    assert.ok(
      !call.args.includes("--dangerously-bypass-approvals-and-sandbox"),
    );
  });

  test("passes --model and --effort, and leaves a partner's defaults to the Codex config", async () => {
    await runScript("codex-partner-ask.mjs", [
      "--model",
      "model-a",
      "--effort=high",
      "Hi",
    ]);
    await runScript("codex-partner-start.mjs", ["review", "Hi"]);
    const [flagged, defaulted] = codexCalls();

    assert.equal(flagged.args[flagged.args.indexOf("--model") + 1], "model-a");
    assert.ok(flagged.args.includes('model_reasoning_effort="high"'));
    assert.ok(!defaulted.args.includes("--model"));
    assert.ok(
      !defaulted.args.some((argument) =>
        argument.startsWith("model_reasoning_effort"),
      ),
    );
  });

  test("reads the prompt from stdin when it is -", async () => {
    const result = await runScript("codex-partner-ask.mjs", ["-"], {
      input: "Line one\nLine two\n",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(codexCalls()[0].stdin, "Line one\nLine two\n");
  });

  test("--json prints the reply as JSON", async () => {
    const result = await runScript("codex-partner-ask.mjs", ["--json", "Hi"]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json, { reply: "reply to: Hi" });
  });

  test("rejects an empty prompt before calling Codex", async () => {
    const result = await runScript("codex-partner-ask.mjs", ["-"], {
      input: "  \n",
    });

    assert.equal(result.status, 1);
    assert.match(result.error, /prompt is empty/);
    assert.deepEqual(codexCalls(), []);
  });

  test("turns off the MCP servers with bare names in the Codex config", async () => {
    mkdirSync(sandbox.codexHome, { recursive: true });
    writeFileSync(
      join(sandbox.codexHome, "config.toml"),
      '[mcp_servers.sentry]\nurl = "x"\n\n[mcp_servers.linear.env]\nA = "1"\n\n[mcp_servers."quoted.name"]\nurl = "y"\n',
    );

    await runScript("codex-partner-ask.mjs", ["Hi"]);
    await runScript("codex-partner-ask.mjs", ["--mcp", "Hi"]);
    const [withoutServers, withServers] = codexCalls();

    assert.ok(withoutServers.args.includes("mcp_servers.sentry.enabled=false"));
    assert.ok(withoutServers.args.includes("mcp_servers.linear.enabled=false"));
    assert.ok(
      !withoutServers.args.some((argument) => argument.includes("quoted")),
    );
    assert.ok(
      !withServers.args.some((argument) => argument.startsWith("mcp_servers.")),
    );
  });

  test("--write runs Codex without a sandbox", async () => {
    await runScript("codex-partner-ask.mjs", ["--write", "Hi"]);
    const [call] = codexCalls();

    assert.ok(call.args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!call.args.includes('sandbox_mode="read-only"'));
  });

  test("surfaces the Codex error message when a turn fails", async () => {
    const result = await runScript("codex-partner-ask.mjs", ["Hi"], {
      env: { FAKE_CODEX_MODE: "fail" },
    });

    assert.equal(result.status, 1);
    assert.match(
      result.error,
      /exited with code 1 without a reply: model overloaded\.$/,
    );
  });

  test("tells the user how to install Codex when it is not on PATH", async () => {
    const result = await runScript("codex-partner-ask.mjs", ["Hi"], {
      env: { PATH: dirname(process.execPath) },
    });

    assert.equal(result.status, 1);
    assert.match(result.error, /npm install -g @openai\/codex/);
  });

  test("rejects an unknown option with the usage text", async () => {
    const result = await runScript("codex-partner-ask.mjs", ["--loud", "Hi"]);

    assert.equal(result.status, 1);
    assert.match(result.error, /Unknown option --loud/);
    assert.match(result.error, /Usage: codex-partner-ask/);
  });

  test("says a boolean option takes no value", async () => {
    const result = await runScript("codex-partner-ask.mjs", [
      "--write=true",
      "Hi",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.error, /The --write option takes no value/);
  });
});

describe("partners", () => {
  test("start saves the partner and say resumes the same Codex thread", async () => {
    const started = await runScript(
      "codex-partner-start.mjs",
      ["review", "--json", "Remember the plan."],
      {
        env: { FAKE_CODEX_THREAD_ID: "thread-42" },
      },
    );
    const continued = await runScript("codex-partner-say.mjs", [
      "review",
      "--json",
      "What was the plan?",
    ]);
    const [startCall, sayCall] = codexCalls();

    assert.equal(started.status, 0, started.stderr);
    assert.deepEqual(started.json, {
      name: "review",
      thread_id: "thread-42",
      reply: "reply to: Remember the plan.",
    });
    assert.equal(continued.status, 0, continued.stderr);
    assert.deepEqual(continued.json, {
      name: "review",
      thread_id: "thread-42",
      reply: "reply to: What was the plan?",
    });
    assert.ok(!startCall.args.includes("--ephemeral"));
    assert.deepEqual(sayCall.args.slice(-3), ["resume", "thread-42", "-"]);
  });

  test("start and say print the reply as plain text", async () => {
    const started = await runScript("codex-partner-start.mjs", [
      "review",
      "Remember the plan.",
    ]);
    const continued = await runScript("codex-partner-say.mjs", [
      "review",
      "What was the plan?",
    ]);

    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout, "reply to: Remember the plan.\n");
    assert.equal(continued.status, 0, continued.stderr);
    assert.equal(continued.stdout, "reply to: What was the plan?\n");
  });

  test("say runs Codex in the directory the partner started in", async () => {
    const startDirectory = join(sandbox.project, "src");

    await runScript("codex-partner-start.mjs", ["review", "Hi"], {
      cwd: startDirectory,
    });
    await runScript("codex-partner-say.mjs", ["review", "Again"], {
      cwd: sandbox.project,
    });
    const [startCall, sayCall] = codexCalls();

    assert.equal(startCall.cwd, sayCall.cwd);
    assert.match(sayCall.cwd, /project\/src$/);
  });

  test("list shows the repository's partners, most recently used first", async () => {
    await runScript("codex-partner-start.mjs", ["first", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-1" },
    });
    await runScript("codex-partner-start.mjs", ["second", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-2" },
    });
    await runScript("codex-partner-say.mjs", ["first", "Again"]);
    const result = await runScript("codex-partner-list.mjs", []);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.json.map((session) => session.name),
      ["first", "second"],
    );
  });

  test("partner names are scoped to their repository, and list --all shows every one", async () => {
    const otherProject = join(sandbox.root, "other");

    mkdirSync(otherProject);
    spawnSync("git", ["init", "-q"], { cwd: otherProject });

    await runScript("codex-partner-start.mjs", ["review", "Hi"]);
    const sameNameElsewhere = await runScript(
      "codex-partner-start.mjs",
      ["review", "Hi"],
      { cwd: otherProject },
    );
    const local = await runScript("codex-partner-list.mjs", [], {
      cwd: otherProject,
    });
    const everywhere = await runScript("codex-partner-list.mjs", ["--all"]);

    assert.equal(sameNameElsewhere.status, 0, sameNameElsewhere.stderr);
    assert.equal(local.json.length, 1);
    assert.equal(everywhere.json.length, 2);
  });

  test("start refuses a name that already exists in the repository", async () => {
    await runScript("codex-partner-start.mjs", ["review", "Hi"]);
    const result = await runScript("codex-partner-start.mjs", [
      "review",
      "Hi again",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.error, /already exists/);
    assert.equal(codexCalls().length, 1);
  });

  test("start fails when Codex reports no thread id", async () => {
    const result = await runScript(
      "codex-partner-start.mjs",
      ["review", "Hi"],
      { env: { FAKE_CODEX_MODE: "no-thread" } },
    );
    const list = await runScript("codex-partner-list.mjs", []);

    assert.equal(result.status, 1);
    assert.match(result.error, /without reporting a thread id/);
    assert.deepEqual(list.json, []);
  });

  test("start refuses to replace a same-name partner saved while Codex answered", async () => {
    const [slow, fast] = await Promise.all([
      runScript("codex-partner-start.mjs", ["review", "Slow"], {
        env: {
          FAKE_CODEX_THREAD_ID: "thread-slow",
          FAKE_CODEX_DELAY_MS: "800",
        },
      }),
      runScript("codex-partner-start.mjs", ["review", "Fast"], {
        env: { FAKE_CODEX_THREAD_ID: "thread-fast" },
      }),
    ]);
    const list = await runScript("codex-partner-list.mjs", []);

    assert.equal(fast.status, 0, fast.stderr);
    assert.equal(slow.status, 1);
    assert.match(
      slow.error,
      /was saved in .* while Codex answered\. This reply is on Codex thread thread-slow/,
    );
    assert.deepEqual(
      list.json.map((partner) => partner.thread_id),
      ["thread-fast"],
    );
  });

  test("say names the command that starts an unknown partner", async () => {
    const result = await runScript("codex-partner-say.mjs", ["missing", "Hi"]);

    assert.equal(result.status, 1);
    assert.match(result.error, /codex-partner-start\.mjs missing/);
  });

  test("say refuses while another live call holds the partner", async () => {
    await runScript("codex-partner-start.mjs", ["review", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-7" },
    });
    mkdirSync(dirname(lockPath("thread-7")), { recursive: true });
    writeFileSync(lockPath("thread-7"), String(process.pid));

    const result = await runScript("codex-partner-say.mjs", [
      "review",
      "Again",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.error, /still answering another message/);
  });

  test("say replaces a lock left behind by a process that exited", async () => {
    const exited = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { encoding: "utf8" },
    );

    await runScript("codex-partner-start.mjs", ["review", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-8" },
    });
    mkdirSync(dirname(lockPath("thread-8")), { recursive: true });
    writeFileSync(lockPath("thread-8"), exited.stdout);

    const result = await runScript("codex-partner-say.mjs", [
      "review",
      "Again",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(lockPath("thread-8")));
  });

  test("forget removes the partner so the name can start over", async () => {
    await runScript("codex-partner-start.mjs", ["review", "Hi"], {
      env: { FAKE_CODEX_THREAD_ID: "thread-9" },
    });
    const forgotten = await runScript("codex-partner-forget.mjs", ["review"]);
    const restarted = await runScript("codex-partner-start.mjs", [
      "review",
      "Hi",
    ]);

    assert.deepEqual(forgotten.json, {
      name: "review",
      thread_id: "thread-9",
      forgotten: true,
    });
    assert.equal(restarted.status, 0, restarted.stderr);
  });

  test("rejects a partner name with spaces or slashes", async () => {
    const result = await runScript("codex-partner-start.mjs", [
      "my/partner",
      "Hi",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.error, /name "my\/partner" is invalid/);
  });
});

describe("codex-partner-review", () => {
  function git(...args) {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
      { cwd: sandbox.project, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
  }

  function commitFile(name) {
    writeFileSync(join(sandbox.project, name), `${name}\n`);
    git("add", name);
    git("commit", "-q", "-m", `Add ${name}`);
  }

  function reviewTarget(result) {
    return result.stdout.match(/^Target: (.*)\n/)?.[1];
  }

  function editFile() {
    writeFileSync(
      join(sandbox.project, "cart.js"),
      "export const total = 0;\n",
    );
  }

  test("reviews the uncommitted changes in a read-only, ephemeral session", async () => {
    editFile();

    const result = await runScript("codex-partner-review.mjs", []);
    const [call] = codexCalls();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(reviewTarget(result), "uncommitted changes");
    assert.deepEqual(call.args.slice(-3), [
      "--ephemeral",
      "review",
      "--uncommitted",
    ]);
    assert.ok(call.args.includes('sandbox_mode="read-only"'));
    assert.ok(
      !call.args.some((argument) =>
        argument.startsWith("model_reasoning_effort"),
      ),
    );
  });

  test("reviews the branch against origin/HEAD when the working tree is clean", async () => {
    git("checkout", "-q", "-b", "feature");
    commitFile("base.txt");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    commitFile("feature.txt");

    const result = await runScript("codex-partner-review.mjs", []);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(reviewTarget(result), "changes against origin/main");
    assert.deepEqual(codexCalls()[0].args.slice(-3), [
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

    const missing = await runScript("codex-partner-review.mjs", []);

    git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );

    const dangling = await runScript("codex-partner-review.mjs", []);

    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(reviewTarget(missing), "changes against main");
    assert.equal(dangling.status, 0, dangling.stderr);
    assert.equal(reviewTarget(dangling), "changes against main");
  });

  test("counts untracked files even when git status hides them", async () => {
    git("checkout", "-q", "-b", "main");
    commitFile("base.txt");
    git("config", "status.showUntrackedFiles", "no");
    editFile();

    const result = await runScript("codex-partner-review.mjs", []);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(reviewTarget(result), "uncommitted changes");
  });

  test("refuses when the tree is clean and HEAD has no commits the default branch lacks", async () => {
    git("checkout", "-q", "-b", "main");
    commitFile("base.txt");

    const result = await runScript("codex-partner-review.mjs", []);

    assert.equal(result.status, 1);
    assert.match(result.error, /Nothing to review/);
    assert.deepEqual(codexCalls(), []);
  });

  test("passes --base and --commit through once git finds them", async () => {
    git("checkout", "-q", "-b", "feature");
    commitFile("base.txt");
    git("branch", "main");
    commitFile("feature.txt");

    const base = await runScript("codex-partner-review.mjs", [
      "--base",
      "main",
    ]);
    const commit = await runScript("codex-partner-review.mjs", [
      "--commit=HEAD",
    ]);
    const missing = await runScript("codex-partner-review.mjs", [
      "--base",
      "release",
    ]);
    const [baseCall, commitCall] = codexCalls();

    assert.equal(reviewTarget(base), "changes against main");
    assert.deepEqual(baseCall.args.slice(-3), ["review", "--base", "main"]);
    assert.equal(reviewTarget(commit), "commit HEAD");
    assert.deepEqual(commitCall.args.slice(-3), ["review", "--commit", "HEAD"]);
    assert.equal(missing.status, 1);
    assert.match(missing.error, /Unable to find the base branch "release"/);
    assert.equal(codexCalls().length, 2);
  });

  test("sends instructions on stdin, and refuses them alongside a target", async () => {
    const result = await runScript("codex-partner-review.mjs", ["-"], {
      input: "Check the auth flow for races.",
    });
    const conflict = await runScript("codex-partner-review.mjs", [
      "--base",
      "main",
      "Focus on auth.",
    ]);
    const [call] = codexCalls();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(reviewTarget(result), "custom instructions");
    assert.deepEqual(call.args.slice(-2), ["review", "-"]);
    assert.equal(call.stdin, "Check the auth flow for races.");
    assert.equal(conflict.status, 1);
    assert.match(conflict.error, /or follows instructions, not both/);
    assert.equal(codexCalls().length, 1);
  });

  test("--as keeps the review as a partner that say continues", async () => {
    editFile();

    const reviewed = await runScript(
      "codex-partner-review.mjs",
      ["--as", "cart", "--effort", "high", "--json"],
      { env: { FAKE_CODEX_THREAD_ID: "thread-7" } },
    );
    const continued = await runScript("codex-partner-say.mjs", [
      "cart",
      "I fixed P1. Check again.",
    ]);
    const [reviewCall, sayCall] = codexCalls();

    assert.equal(reviewed.status, 0, reviewed.stderr);
    assert.deepEqual(reviewed.json, {
      name: "cart",
      thread_id: "thread-7",
      target: "uncommitted changes",
      reply: "review of: --uncommitted",
    });
    assert.ok(!reviewCall.args.includes("--ephemeral"));
    assert.ok(reviewCall.args.includes('model_reasoning_effort="high"'));
    assert.equal(continued.status, 0, continued.stderr);
    assert.deepEqual(sayCall.args.slice(-3), ["resume", "thread-7", "-"]);
  });

  test("prints the target line, then the findings, with or without --as", async () => {
    editFile();

    const [ephemeral, kept] = await Promise.all([
      runScript("codex-partner-review.mjs", []),
      runScript("codex-partner-review.mjs", ["--as", "cart"]),
    ]);

    assert.equal(ephemeral.status, 0, ephemeral.stderr);
    assert.equal(
      ephemeral.stdout,
      "Target: uncommitted changes\n\nreview of: --uncommitted\n",
    );
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(kept.stdout, ephemeral.stdout);
  });

  test("--as refuses a partner name that already exists, before calling Codex", async () => {
    await runScript("codex-partner-start.mjs", ["cart", "Hi"]);
    editFile();

    const result = await runScript("codex-partner-review.mjs", [
      "--as",
      "cart",
    ]);

    assert.equal(result.status, 1);
    assert.match(result.error, /already exists/);
    assert.equal(codexCalls().length, 1);
  });

  test("refuses --write, --base with --commit, and a target outside a git repository", async () => {
    const write = await runScript("codex-partner-review.mjs", ["--write"]);
    const both = await runScript("codex-partner-review.mjs", [
      "--base",
      "main",
      "--commit",
      "HEAD",
    ]);
    const outside = await runScript("codex-partner-review.mjs", [], {
      cwd: sandbox.root,
    });

    assert.match(write.error, /Unknown option --write/);
    assert.match(both.error, /Pass --base or --commit, not both/);
    assert.match(outside.error, /is not inside a git repository/);
    assert.deepEqual(codexCalls(), []);
  });
});

describe("cloud auth", () => {
  let server;
  let tokenUrl;
  let requests;
  let respond;

  beforeEach(async () => {
    requests = [];
    server = createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      const [status, body] = respond();

      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await once(server.listen(0, "127.0.0.1"), "listening");
    tokenUrl = `http://127.0.0.1:${server.address().port}/auth.json`;
  });

  afterEach(() => once(server.close(), "close"));

  const authPath = () => join(sandbox.codexHome, "auth.json");

  test("writes the worker login with mode 600 before calling Codex", async () => {
    respond = () => [200, workerLogin(10 * 24 * HOUR_MS)];

    const result = await runScript("codex-partner-ask.mjs", ["Hi"], {
      env: { CODEX_TOKEN_URL: tokenUrl, CODEX_TOKEN_BEARER: "serve-secret" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer serve-secret");
    assert.equal(
      JSON.parse(readFileSync(authPath(), "utf8")).tokens.account_id,
      "account-1",
    );
    assert.equal(statSync(authPath()).mode & 0o777, 0o600);
  });

  test("reuses a stored worker login until it is about to expire", async () => {
    respond = () => [200, workerLogin(10 * 24 * HOUR_MS)];

    await runScript("codex-partner-auth.mjs", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });
    const reused = await runScript("codex-partner-auth.mjs", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    assert.equal(requests.length, 1);
    assert.equal(reused.json.source, "token-worker");
    assert.equal(reused.json.fetched, false);
    assert.match(reused.json.access_expires_at, /^\d{4}-\d\d-\d\dT/);
  });

  test("fetches a new login when the stored one expires within the hour", async () => {
    mkdirSync(sandbox.codexHome, { recursive: true });
    writeFileSync(authPath(), JSON.stringify(workerLogin(HOUR_MS / 2)));
    respond = () => [200, workerLogin(10 * 24 * HOUR_MS)];

    const result = await runScript("codex-partner-auth.mjs", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    assert.equal(result.json.fetched, true);
    assert.equal(requests.length, 1);
  });

  test("never replaces a Codex login that carries a refresh token", async () => {
    const ownLogin = workerLogin(HOUR_MS);
    ownLogin.tokens.refresh_token = "real-refresh-token";
    mkdirSync(sandbox.codexHome, { recursive: true });
    writeFileSync(authPath(), JSON.stringify(ownLogin));

    const result = await runScript("codex-partner-auth.mjs", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    assert.deepEqual(result.json, { source: "codex-login" });
    assert.equal(requests.length, 0);
    assert.equal(
      JSON.parse(readFileSync(authPath(), "utf8")).tokens.refresh_token,
      "real-refresh-token",
    );
  });

  test("explains the network secret fix when the worker answers 401", async () => {
    respond = () => [401, { error: "Missing or invalid bearer token." }];

    const result = await runScript("codex-partner-ask.mjs", ["Hi"], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    assert.equal(result.status, 1);
    assert.match(result.error, /Add a network secret for 127\.0\.0\.1/);
    assert.deepEqual(codexCalls(), []);
  });

  test("relays the worker's error message for other failures", async () => {
    respond = () => [503, { error: "No Codex login is stored." }];

    const result = await runScript("codex-partner-auth.mjs", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    assert.equal(result.status, 1);
    assert.match(result.error, /answered 503: No Codex login is stored/);
  });

  test("rejects a worker response that is not a Codex login", async () => {
    respond = () => [200, { hello: "world" }];

    const result = await runScript("codex-partner-auth.mjs", [], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    assert.equal(result.status, 1);
    assert.match(result.error, /not a Codex login/);
    assert.ok(!existsSync(authPath()));
  });

  test("--quiet prints nothing and exits 0 even when the worker fails", async () => {
    respond = () => [503, { error: "No Codex login is stored." }];

    const result = await runScript("codex-partner-auth.mjs", ["--quiet"], {
      env: { CODEX_TOKEN_URL: tokenUrl },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.error, /codex-partner: .*No Codex login is stored/);
  });

  test("reports the codex-login source when CODEX_TOKEN_URL is unset", async () => {
    const result = await runScript("codex-partner-auth.mjs", []);

    assert.deepEqual(result.json, { source: "codex-login" });
  });

  test("auth rejects positional arguments", async () => {
    const result = await runScript("codex-partner-auth.mjs", ["now"]);

    assert.equal(result.status, 1);
    assert.match(result.error, /takes no arguments/);
  });
});
