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

/** A saved partner, one entry of the sessions.json list. */
export interface Partner {
  name: string;
  repository: string;
  directory: string;
  thread_id: string;
  created_at: string;
  last_used_at: string;
}

/** What a turn passes to Codex besides the prompt. */
export interface TurnOptions {
  model: string | undefined;
  effort: string | undefined;
  canWrite: boolean;
  keepsMcpServers: boolean;
}

export interface CodexResult {
  threadId: string | undefined;
  reply: string;
}

/** A Codex login the token worker issued: ChatGPT, no refresh token. */
interface WorkerLogin {
  auth_mode: "chatgpt";
  tokens: Record<string, unknown> & { refresh_token: "" };
  [field: string]: unknown;
}

export type LoginReport =
  | { source: "codex-login" }
  | { source: "token-worker"; access_expires_at: string; fetched: boolean };

interface CodexRun {
  exitCode: number;
  signal: NodeJS.Signals | null;
  startedThreadId: string | undefined;
  errorMessages: string[];
  stderrLines: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value for a message: a string as is, anything else as JSON. */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The `code` of a Node system error, such as ENOENT. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export async function main(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message =
      error instanceof PartnerError
        ? error.message
        : `Unexpected failure: ${error instanceof Error ? (error.stack ?? String(error)) : String(error)}`;

    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Prints a Codex reply as plain text, after an optional header line,
 * or the whole result as JSON with --json.
 */
export function printResult(
  result: { reply: string; [field: string]: unknown },
  { asJson, header }: { asJson: boolean; header?: string },
): void {
  if (asJson) {
    printJson(result);

    return;
  }

  if (header) {
    process.stdout.write(`${header}\n\n`);
  }

  process.stdout.write(`${result.reply}\n`);
}

export interface ParsedArguments {
  /** Each value option given, by name. */
  values: Partial<Record<string, string>>;
  /** Each boolean option given. */
  switches: Set<string>;
  positionals: string[];
}

/**
 * Parses `--flag value`, `--flag=value`, and boolean `--flag` arguments.
 *
 * Everything after `--` is positional, so a prompt that starts
 * with a dash survives as long as the caller separates it. Bun keeps
 * a `--` for the script only when another argument comes before it.
 */
export function parseArguments(
  argv: string[],
  {
    usage,
    valueFlags = [],
    booleanFlags = [],
  }: { usage: string; valueFlags?: string[]; booleanFlags?: string[] },
): ParsedArguments {
  const values: Partial<Record<string, string>> = {};
  const switches = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === undefined) {
      break;
    }

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
      switches.add(name);
      continue;
    }

    if (!valueFlags.includes(name)) {
      throw new PartnerError(`Unknown option --${name}.\n\n${usage}`);
    }

    const value = inlineValue ?? argv[++index];

    if (value === undefined || value === "") {
      throw new PartnerError(`The --${name} option needs a value.\n\n${usage}`);
    }

    values[name] = value;
  }

  return { values, switches, positionals };
}

function splitFlag(flag: string): [string, string | undefined] {
  const boundary = flag.indexOf("=");

  return boundary === -1
    ? [flag, undefined]
    : [flag.slice(0, boundary), flag.slice(boundary + 1)];
}

export function parseTurnArguments(
  argv: string[],
  usage: string,
  {
    defaultEffort,
    valueFlags = [],
    allowsWrite = true,
  }: {
    defaultEffort?: string;
    valueFlags?: string[];
    allowsWrite?: boolean;
  } = {},
): ParsedArguments & { options: TurnOptions; asJson: boolean } {
  const parsed = parseArguments(argv, {
    usage,
    valueFlags: ["model", "effort", ...valueFlags],
    booleanFlags: ["mcp", "json", ...(allowsWrite ? ["write"] : [])],
  });

  return {
    ...parsed,
    options: {
      model: parsed.values["model"],
      effort: parsed.values["effort"] ?? defaultEffort,
      canWrite: parsed.switches.has("write"),
      keepsMcpServers: parsed.switches.has("mcp"),
    },
    asJson: parsed.switches.has("json"),
  };
}

export function readPrompt(value: string | undefined, usage: string): string {
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

export function assertPartnerName(
  name: string | undefined,
  usage: string,
): asserts name is string {
  if (name === undefined) {
    throw new PartnerError(`A partner name is required.\n\n${usage}`);
  }

  if (!PARTNER_NAME_PATTERN.test(name)) {
    throw new PartnerError(
      `The partner name "${name}" is invalid. Use 1 to 64 letters, digits, dots, dashes, or underscores, starting with a letter or digit.`,
    );
  }
}

export function repositoryRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });

  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

function partnerHome(): string {
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "codex-partner",
  );
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function partnersPath(): string {
  return join(partnerHome(), "sessions.json");
}

const PARTNER_FIELDS = [
  "name",
  "repository",
  "directory",
  "thread_id",
  "created_at",
  "last_used_at",
] as const;

function isPartnerEntry(value: unknown): value is Partner {
  return (
    isRecord(value) &&
    PARTNER_FIELDS.every((field) => typeof value[field] === "string")
  );
}

export function loadPartners(): Partner[] {
  const path = partnersPath();
  const partners =
    readJsonIfPresent(
      path,
      "Move the file aside, then start the partner again.",
    ) ?? [];

  if (!Array.isArray(partners) || !partners.every(isPartnerEntry)) {
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
export function updatePartners(change: (partners: Partner[]) => Partner[]) {
  writeJsonAtomically(partnersPath(), change(loadPartners()), 0o600);
}

export function isPartner(
  partner: Partner,
  repository: string,
  name: string,
): boolean {
  return partner.repository === repository && partner.name === name;
}

export function findPartner(
  partners: Partner[],
  repository: string,
  name: string,
): Partner | undefined {
  return partners.find((partner) => isPartner(partner, repository, name));
}

export function assertNewPartner(repository: string, name: string): void {
  if (findPartner(loadPartners(), repository, name)) {
    throw new PartnerError(
      `A partner named "${name}" already exists in ${repository}. Continue it with codex-partner-say.ts ${name}, or forget it first.`,
    );
  }
}

/**
 * Saves the Codex thread a turn started as a new partner.
 */
export function savePartner({
  name,
  repository,
  directory,
  threadId,
}: {
  name: string;
  repository: string;
  directory: string;
  threadId: string | undefined;
}): void {
  if (!threadId) {
    throw new PartnerError(
      "Codex replied without reporting a thread id, so the partner cannot be continued.",
    );
  }

  const now = new Date().toISOString();

  updatePartners((partners) => {
    if (findPartner(partners, repository, name)) {
      throw new PartnerError(
        `A partner named "${name}" was saved in ${repository} while Codex answered. This reply is on Codex thread ${threadId}. Continue the saved partner with codex-partner-say.ts ${name}, or forget it first.`,
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
export function holdPartnerLock(threadId: string): void {
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
      if (errorCode(error) !== "EEXIST") {
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
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
}: {
  prompt: string;
  threadId?: string;
  isEphemeral?: boolean;
  options: TurnOptions;
  directory: string;
}): Promise<CodexResult> {
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
}: {
  target: string[];
  instructions?: string | undefined;
  isEphemeral: boolean;
  options: TurnOptions;
  directory: string;
}): Promise<CodexResult> {
  return runCodexExec({
    command: ["review", ...target],
    stdin: instructions,
    threadId: undefined,
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
}: {
  command: string[];
  stdin: string;
  threadId: string | undefined;
  isEphemeral: boolean;
  options: TurnOptions;
  directory: string;
}): Promise<CodexResult> {
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

function spawnCodex(
  codexArguments: string[],
  stdin: string,
  directory: string,
): Promise<CodexRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", codexArguments, { cwd: directory });
    const stderrLines: string[] = [];
    const errorMessages: string[] = [];
    let startedThreadId: string | undefined;
    let pendingStdout = "";

    const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (pendingStdout + chunk).split("\n");
      pendingStdout = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseJsonOrNull(line);

        if (!isRecord(event)) {
          continue;
        }

        if (
          event.type === "thread.started" &&
          typeof event.thread_id === "string"
        ) {
          startedThreadId = event.thread_id;
        }

        if (
          event.type === "error" &&
          typeof event.message === "string" &&
          event.message
        ) {
          errorMessages.push(event.message);
        }

        if (
          event.type === "turn.failed" &&
          isRecord(event.error) &&
          typeof event.error.message === "string" &&
          event.error.message
        ) {
          errorMessages.push(event.error.message);
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) =>
      stderrLines.push(...chunk.split("\n").filter(Boolean)),
    );

    child.on("error", (error) =>
      reject(
        errorCode(error) === "ENOENT" ? new PartnerError(CODEX_MISSING) : error,
      ),
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
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeCodexFailure(
  run: CodexRun,
  threadId: string | undefined,
): string {
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
function mcpServerOverrides(): string[] {
  const configPath = join(codexHome(), "config.toml");

  if (!existsSync(configPath)) {
    return [];
  }

  const serverNames = new Set(
    [
      ...readFileSync(configPath, "utf8").matchAll(
        /^\[mcp_servers\.([A-Za-z0-9_-]+)[\].]/gm,
      ),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
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
export function ensureCodexLogin(): LoginReport {
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

  const currentExpiry = isWorkerIssued(currentLogin)
    ? accessTokenExpiryMs(currentLogin.tokens.access_token)
    : null;

  if (currentExpiry && currentExpiry - Date.now() > FETCH_BELOW_MS) {
    return {
      source: "token-worker",
      access_expires_at: new Date(currentExpiry).toISOString(),
      fetched: false,
    };
  }

  const { login, expiresAt } = fetchWorkerLogin(tokenUrl);

  writeJsonAtomically(loginPath, login, 0o600);

  return {
    source: "token-worker",
    access_expires_at: new Date(expiresAt).toISOString(),
    fetched: true,
  };
}

// The worker issues its logins with an empty refresh token.
function isWorkerIssued(login: unknown): login is WorkerLogin {
  return (
    isRecord(login) &&
    login.auth_mode === "chatgpt" &&
    isRecord(login.tokens) &&
    login.tokens.refresh_token === ""
  );
}

/**
 * Fetches with curl, which honors the cloud VM's HTTPS proxy and CA store.
 */
function fetchWorkerLogin(tokenUrl: string): {
  login: WorkerLogin;
  expiresAt: number;
} {
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

  if (errorCode(result.error) === "ENOENT") {
    throw new PartnerError(
      "Unable to find curl on PATH. Install curl, then try again.",
    );
  }

  if (result.status !== 0) {
    throw new PartnerError(
      `Unable to reach the token worker at ${host}: ${result.stderr.trim() || `curl exit ${String(result.status)}`}.`,
    );
  }

  const boundary = result.stdout.lastIndexOf("\n");
  const status = Number(result.stdout.slice(boundary + 1));
  const body = parseJsonOrNull(result.stdout.slice(0, boundary));

  if (status === 401) {
    throw new PartnerError(
      process.env.CODEX_TOKEN_BEARER
        ? `The token worker at ${host} rejected the serve token in CODEX_TOKEN_BEARER (401). In a cloud environment the session holds only a placeholder, so check that the network secret for ${host} holds the worker's SERVE_TOKEN; elsewhere, check the variable itself. Then start a new session.`
        : `The token worker at ${host} rejected the request (401): CODEX_TOKEN_BEARER is unset, so it carried no serve token. In a cloud environment, add a network secret for ${host} exposed as CODEX_TOKEN_BEARER, then start a new session.`,
    );
  }

  if (status !== 200) {
    const message = isRecord(body) ? body.error : undefined;

    throw new PartnerError(
      `The token worker at ${host} answered ${status}: ${message === undefined || message === null ? "no error message." : asText(message)}`,
    );
  }

  const expiresAt = isWorkerIssued(body)
    ? accessTokenExpiryMs(body.tokens.access_token)
    : null;

  if (!isWorkerIssued(body) || !expiresAt) {
    throw new PartnerError(
      `The token worker at ${host} returned a response that is not a Codex login.`,
    );
  }

  return { login: body, expiresAt };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new PartnerError(
      `CODEX_TOKEN_URL is "${url}", which is not a valid URL.`,
    );
  }
}

function accessTokenExpiryMs(accessToken: unknown): number | null {
  const payload =
    typeof accessToken === "string" ? accessToken.split(".")[1] : undefined;

  if (!payload) {
    return null;
  }

  const claims = parseJsonOrNull(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  const exp = isRecord(claims) ? claims.exp : undefined;

  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

function readJsonIfPresent(path: string, fix: string): unknown {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PartnerError(`Unable to parse ${path}. ${fix}`);
  }
}

function writeJsonAtomically(path: string, value: unknown, mode: number) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const temporaryPath = `${path}.${process.pid}.tmp`;

  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporaryPath, path);
}
