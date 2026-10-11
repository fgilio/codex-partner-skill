#!/usr/bin/env node
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PartnerError,
  codexHome,
  main,
  parseArguments,
  printJson,
} from "../../skills/codex-partner/scripts/lib.mjs";
import {
  accessTokenExpiry,
  generateBundleKey,
  sealBundle,
} from "../src/bundle.mjs";

const USAGE = `Usage: node token-worker/scripts/seed.mjs [--auth <auth.json>]

Signs in to ChatGPT with \`codex login\` in a temporary Codex home, seals the
login with a new BUNDLE_KEY, and stores both in the worker. Pass --auth to
store an existing dedicated login instead.

Requires wrangler (logged in) and CLOUDFLARE_ACCOUNT_ID for the worker's account.
`;

const workerDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workerDirectory,
    encoding: "utf8",
    ...options,
  });

  if (result.error?.code === "ENOENT") {
    throw new PartnerError(
      `Unable to find ${command} on PATH. Install it, then run this script again.`,
    );
  }

  if (result.status !== 0) {
    throw new PartnerError(
      `${command} ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }

  return result;
}

function readLogin(path) {
  if (!existsSync(path)) {
    throw new PartnerError(
      `No Codex login found at ${path}. Sign in with \`codex login\`, then run this script again.`,
    );
  }

  const login = JSON.parse(readFileSync(path, "utf8"));

  if (
    login.auth_mode !== "chatgpt" ||
    !login.tokens?.refresh_token ||
    !accessTokenExpiry(login.tokens.access_token)
  ) {
    throw new PartnerError(
      `${path} is not a ChatGPT login with a refresh token. Sign in with ChatGPT, not an API key.`,
    );
  }

  return login;
}

function signInToDedicatedHome(dedicatedHome) {
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

  if (result.status !== 0) {
    throw new PartnerError(
      "`codex login` did not finish. Run this script again and complete the sign-in in the browser.",
    );
  }

  return join(dedicatedHome, "auth.json");
}

main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    valueFlags: ["auth"],
  });

  if (positionals.length > 0) {
    throw new PartnerError(
      `Unknown arguments: ${positionals.join(" ")}\n\n${USAGE}`,
    );
  }

  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new PartnerError(
      "Set CLOUDFLARE_ACCOUNT_ID to the Cloudflare account that hosts the worker.",
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "codex-token-seed-"));

  try {
    const loginPath = flags.auth
      ? resolve(flags.auth)
      : signInToDedicatedHome(join(scratch, "codex-home"));
    const sharedLoginPath = join(codexHome(), "auth.json");

    // A login another machine refreshes would spend the worker's
    // refresh token, so the everyday Codex login is never accepted.
    if (
      existsSync(sharedLoginPath) &&
      realpathSync(loginPath) === realpathSync(sharedLoginPath)
    ) {
      throw new PartnerError(
        `${loginPath} is the Codex login this machine refreshes. Run the script without --auth to create a dedicated one.`,
      );
    }

    const login = readLogin(loginPath);
    const bundleKey = generateBundleKey();
    const sealedPath = join(scratch, "bundle.json");

    writeFileSync(sealedPath, await sealBundle(login, bundleKey), {
      mode: 0o600,
    });

    run("wrangler", [
      "kv",
      "key",
      "put",
      "bundle",
      "--binding",
      "CODEX_AUTH",
      "--remote",
      "--path",
      sealedPath,
    ]);
    run("wrangler", ["secret", "put", "BUNDLE_KEY"], { input: bundleKey });
    run("wrangler", [
      "kv",
      "key",
      "put",
      "status",
      JSON.stringify({ seeded_at: new Date().toISOString(), last_error: null }),
      "--binding",
      "CODEX_AUTH",
      "--remote",
    ]);

    printJson({
      seeded: true,
      account_id: login.tokens.account_id,
      access_expires_at: new Date(
        accessTokenExpiry(login.tokens.access_token),
      ).toISOString(),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
