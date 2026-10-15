/**
 * Shared runtime for the codex-partner scripts.
 *
 * Every Codex call goes through runCodexExec(), so stdin, sandbox,
 * MCP, and login handling stay in one place.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PARTNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CODEX_MISSING =
  "Unable to find the codex executable on PATH. Install it with `npm install -g @openai/codex`, then try again.";

// Codex refreshes a token 5 minutes before it expires, and a worker-issued
// login cannot refresh, so fetch a new one well before that point.
const FETCH_BELOW_MS = 60 * 60 * 1000;

export class PartnerError extends Error {}

export async function main(run) {
  try {
    await run();
  } catch (error) {
    const message =
      error instanceof PartnerError
        ? error.message
        : `Unexpected failure: ${error?.stack ?? error}`;

    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Prints a Codex reply as plain text, after an optional header line,
 * or the whole result as JSON with --json.
 */
export function printResult(result, { asJson, header }) {
  if (asJson) {
    printJson(result);

    return;
  }

  if (header) {
    process.stdout.write(`${header}\n\n`);
  }

  process.stdout.write(`${result.reply}\n`);
}

/**
 * Parses `--flag value`, `--flag=value`, and boolean `--flag` arguments.
 *
 * Everything after `--` is positional, so a prompt that starts
 * with a dash survives as long as the caller separates it.
 */
export function parseArguments(
  argv,
  { usage, valueFlags = [], booleanFlags = [] },
) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage);
      process.exit(0);
    }

    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const [name, inlineValue] = splitFlag(argument.slice(2));

    if (booleanFlags.includes(name) && inlineValue !== undefined) {
      throw new PartnerError(
        `The --${name} option takes no value.\n\n${usage}`,
      );
    }

    if (booleanFlags.includes(name)) {
      flags[name] = true;
      continue;
    }

    if (!valueFlags.includes(name)) {
      throw new PartnerError(`Unknown option --${name}.\n\n${usage}`);
    }

    const value = inlineValue ?? argv[++index];

    if (value === undefined || value === "") {
      throw new PartnerError(`The --${name} option needs a value.\n\n${usage}`);
    }

    flags[name] = value;
  }

  return { flags, positionals };
}

function splitFlag(flag) {
  const boundary = flag.indexOf("=");

  return boundary === -1
    ? [flag, undefined]
    : [flag.slice(0, boundary), flag.slice(boundary + 1)];
}

export function parseTurnArguments(
  argv,
  usage,
  { defaultEffort, valueFlags = [], allowsWrite = true } = {},
) {
  const { flags, positionals } = parseArguments(argv, {
    usage,
    valueFlags: ["model", "effort", ...valueFlags],
    booleanFlags: ["mcp", "json", ...(allowsWrite ? ["write"] : [])],
  });

  return {
    flags,
    positionals,
    options: {
      model: flags.model,
      effort: flags.effort ?? defaultEffort,
      canWrite: flags.write === true,
      keepsMcpServers: flags.mcp === true,
    },
    asJson: flags.json === true,
  };
}

export function readPrompt(value, usage) {
  if (value === undefined) {
    throw new PartnerError(`A prompt is required.\n\n${usage}`);
  }

  const prompt = value === "-" ? readFileSync(0, "utf8") : value;

  if (!prompt.trim()) {
    throw new PartnerError(
      "The prompt is empty. Pass the message as the last argument, or pass - and pipe it on stdin.",
    );
  }

  return prompt;
}

export function assertPartnerName(name, usage) {
  if (name === undefined) {
    throw new PartnerError(`A partner name is required.\n\n${usage}`);
  }

  if (!PARTNER_NAME_PATTERN.test(name)) {
    throw new PartnerError(
      `The partner name "${name}" is invalid. Use 1 to 64 letters, digits, dots, dashes, or underscores, starting with a letter or digit.`,
    );
  }
}

export function repositoryRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });

  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

function partnerHome() {
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "codex-partner",
  );
}

export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function partnersPath() {
  return join(partnerHome(), "sessions.json");
}

export function loadPartners() {
  const path = partnersPath();
  const partners =
    readJsonIfPresent(
      path,
      "Move the file aside, then start the partner again.",
    ) ?? [];

  if (!Array.isArray(partners)) {
    throw new PartnerError(
      `${path} does not hold a list of partners. Move the file aside, then start the partner again.`,
    );
  }

  return partners;
}

/**
 * Reloads the partner list just before each write, so only that
 * short window can lose a change saved by a concurrent call.
 */
export function updatePartners(change) {
  writeJsonAtomically(partnersPath(), change(loadPartners()), 0o600);
}

export function isPartner(partner, repository, name) {
  return partner.repository === repository && partner.name === name;
}

export function findPartner(partners, repository, name) {
  return partners.find((partner) => isPartner(partner, repository, name));
}

export function assertNewPartner(repository, name) {
  if (findPartner(loadPartners(), repository, name)) {
    throw new PartnerError(
      `A partner named "${name}" already exists in ${repository}. Continue it with codex-partner-say.mjs ${name}, or forget it first.`,
    );
  }
}

/**
 * Saves the Codex thread a turn started as a new partner.
 */
export function savePartner({ name, repository, directory, threadId }) {
  if (!threadId) {
    throw new PartnerError(
      "Codex replied without reporting a thread id, so the partner cannot be continued.",
    );
  }

  const now = new Date().toISOString();

  updatePartners((partners) => {
    if (findPartner(partners, repository, name)) {
      throw new PartnerError(
        `A partner named "${name}" was saved in ${repository} while Codex answered. This reply is on Codex thread ${threadId}. Continue the saved partner with codex-partner-say.mjs ${name}, or forget it first.`,
      );
    }

    return [
      ...partners,
      {
        name,
        repository,
        directory,
        thread_id: threadId,
        created_at: now,
        last_used_at: now,
      },
    ];
  });
}

/**
 * Lets one message at a time reach a partner. Codex appends every
 * turn to the same session file, so two resumes would interleave.
 */
export function holdPartnerLock(threadId) {
  const lockDirectory = join(partnerHome(), "locks");
  const lockPath = join(lockDirectory, `${threadId}.lock`);

  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);

      writeFileSync(descriptor, String(process.pid));
      closeSync(descriptor);
      process.on("exit", () => rmSync(lockPath, { force: true }));

      return;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const holder = Number(readFileSync(lockPath, "utf8"));

      if (isProcessAlive(holder)) {
        throw new PartnerError(
          `The partner is still answering another message (pid ${holder}). Wait for that call to finish, then send this one.`,
        );
      }

      rmSync(lockPath, { force: true });
    }
  }

  throw new PartnerError(
    `Unable to take the partner lock at ${lockPath}. Remove the file, then try again.`,
  );
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Runs one Codex turn and returns its thread id and final message.
 */
export function runCodexTurn({
  prompt,
  threadId,
  isEphemeral = false,
  options,
  directory,
}) {
  return runCodexExec({
    // "-" reads the prompt from stdin, clear of argv length limits.
    command: threadId ? ["resume", threadId, "-"] : ["-"],
    stdin: prompt,
    threadId,
    isEphemeral,
    options,
    directory,
  });
}

/**
 * Runs Codex's built-in code review and returns its thread id and findings.
 *
 * The target is review flags such as `--uncommitted`, or `-` with
 * the review instructions on stdin.
 */
export function runCodexReview({
  target,
  instructions = "",
  isEphemeral,
  options,
  directory,
}) {
  return runCodexExec({
    command: ["review", ...target],
    stdin: instructions,
    isEphemeral,
    options: { ...options, canWrite: false },
    directory,
  });
}

async function runCodexExec({
  command,
  stdin,
  threadId,
  isEphemeral,
  options,
  directory,
}) {
  ensureCodexLogin();

  const scratch = mkdtempSync(join(tmpdir(), "codex-partner-"));
  const replyPath = join(scratch, "reply.md");
  const codexArguments = [
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--output-last-message",
    replyPath,
    ...(options.canWrite
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["--config", 'sandbox_mode="read-only"']),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.effort
      ? ["--config", `model_reasoning_effort="${options.effort}"`]
      : []),
    ...(options.keepsMcpServers ? [] : mcpServerOverrides()),
    ...(isEphemeral ? ["--ephemeral"] : []),
    ...command,
  ];

  try {
    const run = await spawnCodex(codexArguments, stdin, directory);
    const reply = existsSync(replyPath)
      ? readFileSync(replyPath, "utf8").trim()
      : "";
    const resolvedThreadId = run.startedThreadId ?? threadId;

    if (run.exitCode !== 0 || !reply) {
      throw new PartnerError(describeCodexFailure(run, threadId));
    }

    return { threadId: resolvedThreadId, reply };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function spawnCodex(codexArguments, stdin, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", codexArguments, { cwd: directory });
    const stderrLines = [];
    const errorMessages = [];
    let startedThreadId;
    let pendingStdout = "";

    const forwardSignal = (signal) => child.kill(signal);
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const lines = (pendingStdout + chunk).split("\n");
      pendingStdout = lines.pop();

      for (const line of lines) {
        const event = parseJsonOrNull(line);

        if (event?.type === "thread.started") {
          startedThreadId = event.thread_id;
        }

        if (event?.type === "error" && event.message) {
          errorMessages.push(event.message);
        }

        if (event?.type === "turn.failed" && event.error?.message) {
          errorMessages.push(event.error.message);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) =>
      stderrLines.push(...chunk.split("\n").filter(Boolean)),
    );

    child.on("error", (error) =>
      reject(error.code === "ENOENT" ? new PartnerError(CODEX_MISSING) : error),
    );
    child.on("close", (exitCode, signal) => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
      resolve({
        exitCode: exitCode ?? 128,
        signal,
        startedThreadId,
        errorMessages,
        stderrLines,
      });
    });

    // Codex can exit before it reads stdin. The close handler reports that.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeCodexFailure(run, threadId) {
  const detail = (
    run.errorMessages.at(-1) ?? run.stderrLines.slice(-5).join("\n")
  )
    .trim()
    .replace(/\.$/, "");
  const outcome = run.signal
    ? `stopped by ${run.signal}`
    : `exited with code ${run.exitCode}`;
  const hint = threadId
    ? " If Codex no longer has this session, forget the partner and start a new one with a recap."
    : "";

  return `Codex ${outcome} without a reply${detail ? `: ${detail}` : ""}.${hint}`;
}

/**
 * Turns off every MCP server named in the Codex config.
 *
 * Only bare TOML keys can be addressed: the --config parser splits
 * on every dot, so a quoted name such as "a.b" stays enabled. An
 * `mcp_servers={}` override merges into the table and changes nothing.
 */
function mcpServerOverrides() {
  const configPath = join(codexHome(), "config.toml");

  if (!existsSync(configPath)) {
    return [];
  }

  const serverNames = new Set(
    [
      ...readFileSync(configPath, "utf8").matchAll(
        /^\[mcp_servers\.([A-Za-z0-9_-]+)[\].]/gm,
      ),
    ].map((match) => match[1]),
  );

  return [...serverNames].flatMap((name) => [
    "--config",
    `mcp_servers.${name}.enabled=false`,
  ]);
}

/**
 * Keeps a worker-issued Codex login current when CODEX_TOKEN_URL is set.
 *
 * A login with a refresh token belongs to `codex login` and is
 * never replaced.
 */
export function ensureCodexLogin() {
  const tokenUrl = process.env.CODEX_TOKEN_URL;

  if (!tokenUrl) {
    return { source: "codex-login" };
  }

  const loginPath = join(codexHome(), "auth.json");
  const currentLogin = readJsonIfPresent(
    loginPath,
    "Run `codex login`, or delete the file to use the token worker.",
  );

  if (currentLogin && !isWorkerIssued(currentLogin)) {
    return { source: "codex-login" };
  }

  const currentExpiry = accessTokenExpiryMs(currentLogin?.tokens.access_token);
  const needsFetch =
    !currentExpiry || currentExpiry - Date.now() <= FETCH_BELOW_MS;
  const login = needsFetch ? fetchWorkerLogin(tokenUrl) : currentLogin;

  if (needsFetch) {
    writeJsonAtomically(loginPath, login, 0o600);
  }

  return {
    source: "token-worker",
    access_expires_at: new Date(
      accessTokenExpiryMs(login.tokens.access_token),
    ).toISOString(),
    fetched: needsFetch,
  };
}

// The worker issues its logins with an empty refresh token.
function isWorkerIssued(login) {
  return login.auth_mode === "chatgpt" && login.tokens?.refresh_token === "";
}

/**
 * Fetches with curl, which honors the cloud VM's HTTPS proxy and CA store.
 */
function fetchWorkerLogin(tokenUrl) {
  const host = hostOf(tokenUrl);
  const headers = ["Accept: application/json"];

  if (process.env.CODEX_TOKEN_BEARER) {
    headers.push(`Authorization: Bearer ${process.env.CODEX_TOKEN_BEARER}`);
  }

  const result = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--max-time",
      "20",
      // Headers come from stdin, so the serve token stays out of ps.
      "--header",
      "@-",
      "--write-out",
      "\n%{http_code}",
      tokenUrl,
    ],
    { input: headers.join("\n"), encoding: "utf8" },
  );

  if (result.error?.code === "ENOENT") {
    throw new PartnerError(
      "Unable to find curl on PATH. Install curl, then try again.",
    );
  }

  if (result.status !== 0) {
    throw new PartnerError(
      `Unable to reach the token worker at ${host}: ${result.stderr.trim() || `curl exit ${result.status}`}.`,
    );
  }

  const boundary = result.stdout.lastIndexOf("\n");
  const status = Number(result.stdout.slice(boundary + 1));
  const body = parseJsonOrNull(result.stdout.slice(0, boundary));

  if (status === 401) {
    throw new PartnerError(
      `The token worker at ${host} rejected the request (401). Add a network secret for ${host} with the worker's serve token, or set CODEX_TOKEN_BEARER outside a cloud session.`,
    );
  }

  if (status !== 200) {
    throw new PartnerError(
      `The token worker at ${host} answered ${status}: ${body?.error ?? "no error message."}`,
    );
  }

  if (
    !isWorkerIssued(body ?? {}) ||
    !accessTokenExpiryMs(body.tokens.access_token)
  ) {
    throw new PartnerError(
      `The token worker at ${host} returned a response that is not a Codex login.`,
    );
  }

  return body;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    throw new PartnerError(
      `CODEX_TOKEN_URL is "${url}", which is not a valid URL.`,
    );
  }
}

function accessTokenExpiryMs(accessToken) {
  const payload =
    typeof accessToken === "string" ? accessToken.split(".")[1] : undefined;

  if (!payload) {
    return null;
  }

  try {
    const { exp } = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );

    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function readJsonIfPresent(path, fix) {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PartnerError(`Unable to parse ${path}. ${fix}`);
  }
}

function writeJsonAtomically(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const temporaryPath = `${path}.${process.pid}.tmp`;

  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporaryPath, path);
}
