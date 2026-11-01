#!/usr/bin/env bun
/**
 * Stores a dedicated ChatGPT login in the token worker.
 *
 * Signs in with `codex login` in a temporary Codex home, so the
 * worker owns a login that no other machine ever refreshes.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  PartnerError,
  codexHome,
  errorCode,
  main,
  parseArguments,
  printJson,
} from "../../skills/codex-partner/scripts/lib";
import {
  accessTokenExpiryMs,
  generateBundleKey,
  isStoredLogin,
  sealBundle,
} from "../src/bundle";
import type { StoredLogin } from "../src/bundle";
import { BUNDLE_KV_KEY, STATUS_KV_KEY } from "../src/index";

const USAGE = `Usage: bun token-worker/scripts/seed.ts [--auth <auth.json>]

Signs in to ChatGPT with \`codex login\` in a temporary Codex home, seals the
login with a new BUNDLE_KEY, and stores both in the worker. Pass --auth to
store an existing dedicated login instead.

Requires CLOUDFLARE_ACCOUNT_ID for the worker's account and a wrangler login.
Runs the wrangler that bun.lock pins (run \`bun install\` first), or the one
CODEX_TOKEN_WRANGLER names.
`;

export const WORKER_DIRECTORY = resolve(import.meta.dir, "..");

/** The wrangler that `bun install` puts in the repository, at its pinned version. */
export const PINNED_WRANGLER = resolve(
  WORKER_DIRECTORY,
  "..",
  "node_modules",
  ".bin",
  "wrangler",
);

/** Runs one command to completion, or throws a PartnerError that names it. */
export type CommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => void;

export interface SeedSummary {
  seeded: true;
  account_id: unknown;
  access_expires_at: string;
}

function missingCommand(command: string): PartnerError {
  return new PartnerError(
    command.includes("/")
      ? `Unable to find ${command}. Run \`bun install\` at the repository root, then run this script again.`
      : `Unable to find ${command} on PATH. Install it, then run this script again.`,
  );
}

/** Runs commands in the worker directory, so wrangler reads its config. */
export function commandRunner(
  cwd = WORKER_DIRECTORY,
  env: NodeJS.ProcessEnv = process.env,
): CommandRunner {
  return (command, args, input) => {
    const result = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
    });

    if (errorCode(result.error) === "ENOENT") {
      throw missingCommand(command);
    }

    if (result.status !== 0) {
      const detail =
        result.stderr ||
        result.stdout ||
        result.error?.message ||
        `exit ${String(result.status)}`;

      throw new PartnerError(
        `${basename(command)} ${args.slice(0, 3).join(" ")} failed: ${detail.trim()}`,
      );
    }
  };
}

/**
 * Reads a ChatGPT login with a refresh token and a readable access token
 * expiry, the only kind the worker can keep fresh.
 */
export function readLogin(path: string): StoredLogin {
  if (!existsSync(path)) {
    throw new PartnerError(
      `No Codex login found at ${path}. Sign in with \`codex login\`, then run this script again.`,
    );
  }

  let login: unknown;

  try {
    login = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new PartnerError(
      `Unable to parse ${path} as JSON. Pass the auth.json that \`codex login\` wrote.`,
    );
  }

  if (
    !isStoredLogin(login) ||
    login.auth_mode !== "chatgpt" ||
    !login.tokens.refresh_token
  ) {
    throw new PartnerError(
      `${path} is not a ChatGPT login with a refresh token. Sign in with ChatGPT, not an API key.`,
    );
  }

  if (!accessTokenExpiryMs(login.tokens.access_token)) {
    throw new PartnerError(
      `${path} holds an access token with no readable expiry. Sign in again with \`codex login\`.`,
    );
  }

  return login;
}

/**
 * A login another machine refreshes would spend the worker's refresh
 * token, so the everyday Codex login is never accepted.
 */
export function assertDedicatedLogin(
  loginPath: string,
  sharedLoginPath: string,
): void {
  if (
    existsSync(sharedLoginPath) &&
    realpathSync(loginPath) === realpathSync(sharedLoginPath)
  ) {
    throw new PartnerError(
      `${loginPath} is the Codex login this machine refreshes. Run the script without --auth to create a dedicated one.`,
    );
  }
}

/**
 * Seals the login under a new BUNDLE_KEY in the scratch directory, then
 * stores the sealed login, the key, and a fresh status through wrangler.
 */
export async function storeInWorker({
  login,
  scratch,
  run,
  wrangler = PINNED_WRANGLER,
  now = new Date(),
  bundleKey = generateBundleKey(),
}: {
  login: StoredLogin;
  scratch: string;
  run: CommandRunner;
  wrangler?: string;
  now?: Date;
  bundleKey?: string;
}): Promise<SeedSummary> {
  const sealedPath = join(scratch, "bundle.json");

  writeFileSync(sealedPath, await sealBundle(login, bundleKey), {
    mode: 0o600,
  });

  run(wrangler, [
    "kv",
    "key",
    "put",
    BUNDLE_KV_KEY,
    "--binding",
    "CODEX_AUTH",
    "--remote",
    "--path",
    sealedPath,
  ]);
  run(wrangler, ["secret", "put", "BUNDLE_KEY"], bundleKey);
  run(wrangler, [
    "kv",
    "key",
    "put",
    STATUS_KV_KEY,
    JSON.stringify({ seeded_at: now.toISOString(), last_error: null }),
    "--binding",
    "CODEX_AUTH",
    "--remote",
  ]);

  return {
    seeded: true,
    account_id: login.tokens.account_id,
    access_expires_at: new Date(
      accessTokenExpiryMs(login.tokens.access_token) ?? 0,
    ).toISOString(),
  };
}

function signInToDedicatedHome(dedicatedHome: string): string {
  process.stderr.write(
    "Opening the ChatGPT sign-in for a login only the worker uses...\n",
  );

  // Codex refuses to start when CODEX_HOME points at a missing directory.
  mkdirSync(dedicatedHome, { mode: 0o700 });

  const result = spawnSync(
    "codex",
    ["login", "--config", 'cli_auth_credentials_store="file"'],
    {
      env: { ...process.env, CODEX_HOME: dedicatedHome },
      stdio: "inherit",
    },
  );

  if (errorCode(result.error) === "ENOENT") {
    throw missingCommand("codex");
  }

  if (result.status !== 0) {
    throw new PartnerError(
      "`codex login` did not finish. Run this script again and complete the sign-in in the browser.",
    );
  }

  return join(dedicatedHome, "auth.json");
}

if (import.meta.main) {
  await main(async () => {
    const { values, positionals } = parseArguments(process.argv.slice(2), {
      usage: USAGE,
      valueFlags: ["auth"],
    });

    if (positionals.length > 0) {
      throw new PartnerError(
        `seed.ts takes no positional arguments.\n\n${USAGE}`,
      );
    }

    if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
      throw new PartnerError(
        "Set CLOUDFLARE_ACCOUNT_ID to the Cloudflare account that hosts the worker.",
      );
    }

    const scratch = mkdtempSync(join(tmpdir(), "codex-token-seed-"));

    try {
      const loginPath = values["auth"]
        ? resolve(values["auth"])
        : signInToDedicatedHome(join(scratch, "codex-home"));
      const login = readLogin(loginPath);

      assertDedicatedLogin(loginPath, join(codexHome(), "auth.json"));

      printJson(
        await storeInWorker({
          login,
          scratch,
          run: commandRunner(),
          wrangler: process.env.CODEX_TOKEN_WRANGLER || PINNED_WRANGLER,
        }),
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
