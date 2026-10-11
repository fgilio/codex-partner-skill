#!/usr/bin/env node
// Prints the token worker's status: access token expiry and the last refresh outcome.

import {
  PartnerError,
  main,
  parseArguments,
  printJson,
} from "../../skills/codex-partner/scripts/lib.mjs";

const USAGE = `Usage: CODEX_TOKEN_URL=<url>/auth.json CODEX_TOKEN_BEARER=<serve token> node token-worker/scripts/status.mjs
`;

main(async () => {
  parseArguments(process.argv.slice(2), { usage: USAGE });

  const { CODEX_TOKEN_URL: tokenUrl, CODEX_TOKEN_BEARER: bearer } = process.env;

  if (!tokenUrl || !bearer) {
    throw new PartnerError(
      `Set CODEX_TOKEN_URL and CODEX_TOKEN_BEARER.\n\n${USAGE}`,
    );
  }

  const response = await fetch(new URL("/status", tokenUrl), {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new PartnerError(
      `The token worker answered ${response.status}: ${body?.error ?? "no error message"}`,
    );
  }

  printJson(body);
});
