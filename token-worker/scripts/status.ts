#!/usr/bin/env bun
// Prints the token worker's status: access token expiry and the last refresh outcome.

import {
  PartnerError,
  asText,
  isRecord,
  main,
  parseArguments,
  printJson,
} from "../../skills/codex-partner/scripts/lib";

const USAGE = `Usage: CODEX_TOKEN_URL=<url>/auth.json CODEX_TOKEN_BEARER=<serve token> bun token-worker/scripts/status.ts
`;

/** The fetch this script calls, so tests can answer for the worker. */
export type Fetcher = (url: URL, init: RequestInit) => Promise<Response>;

/** Reads the worker's /status with the serve token and returns its body. */
export async function fetchStatus(
  env: Partial<Record<string, string>>,
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  const { CODEX_TOKEN_URL: tokenUrl, CODEX_TOKEN_BEARER: bearer } = env;

  if (!tokenUrl) {
    throw new PartnerError(
      `Set CODEX_TOKEN_URL to the worker's /auth.json URL.\n\n${USAGE}`,
    );
  }

  if (!bearer) {
    throw new PartnerError(
      `Set CODEX_TOKEN_BEARER to the worker's serve token.\n\n${USAGE}`,
    );
  }

  const response = await fetcher(new URL("/status", tokenUrl), {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const message = isRecord(body) ? body.error : undefined;

    throw new PartnerError(
      `The token worker answered ${response.status}: ${message === undefined || message === null ? "no error message" : asText(message)}`,
    );
  }

  return body;
}

if (import.meta.main) {
  await main(async () => {
    parseArguments(process.argv.slice(2), { usage: USAGE });

    printJson(await fetchStatus(process.env));
  });
}
