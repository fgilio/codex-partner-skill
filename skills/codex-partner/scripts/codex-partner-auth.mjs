#!/usr/bin/env node
// Reports where Codex gets its login, and fetches a token-worker login when CODEX_TOKEN_URL is set.

import {
  PartnerError,
  ensureCodexLogin,
  main,
  parseArguments,
  printJson,
} from "./lib.mjs";

const USAGE = `Usage: codex-partner-auth.mjs [--quiet]

Without CODEX_TOKEN_URL, Codex uses its own login and nothing changes.
With CODEX_TOKEN_URL, fetches a short-lived access token from the token worker
when the stored one is missing or close to expiry. A login made with
\`codex login\` is never replaced.

Options:
  --quiet   Print nothing on success and always exit 0 (for SessionStart hooks)
`;

main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    booleanFlags: ["quiet"],
  });

  if (positionals.length > 0) {
    throw new PartnerError(
      `codex-partner-auth.mjs takes no arguments.\n\n${USAGE}`,
    );
  }

  if (!flags.quiet) {
    printJson(ensureCodexLogin());

    return;
  }

  try {
    ensureCodexLogin();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: `codex-partner: ${error.message}` })}\n`,
    );
  }
});
