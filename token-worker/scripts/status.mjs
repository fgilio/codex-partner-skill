#!/usr/bin/env node
// Prints the token worker's status: access token expiry and the last refresh outcome.

const USAGE = `Usage: CODEX_TOKEN_URL=<url>/auth.json CODEX_TOKEN_BEARER=<serve token> node token-worker/scripts/status.mjs
`;

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const { CODEX_TOKEN_URL: tokenUrl, CODEX_TOKEN_BEARER: bearer } = process.env;

if (!tokenUrl || !bearer) {
  fail(`Set CODEX_TOKEN_URL and CODEX_TOKEN_BEARER.\n\n${USAGE}`);
}

const response = await fetch(new URL("/status", tokenUrl), {
  headers: { Authorization: `Bearer ${bearer}` },
});
const body = await response.json().catch(() => null);

if (!response.ok) {
  fail(
    `The token worker answered ${response.status}: ${body?.error ?? "no error message"}`,
  );
}

process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
