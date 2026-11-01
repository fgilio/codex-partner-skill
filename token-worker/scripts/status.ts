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
): Promise<Record<string, unknown>> {
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

  const statusUrl = new URL("/status", tokenUrl);
  const response = await fetcher(statusUrl, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const text = await response.text();
  const body = parseJsonOrNull(text);

  if (!response.ok) {
    const message = isRecord(body) ? body.error : undefined;

    throw new PartnerError(
      `The token worker answered ${response.status}: ${message === undefined || message === null ? "no error message" : asText(message)}`,
    );
  }

  // A proxy or a sign-in page in front of the worker answers 200 too.
  if (!isRecord(body)) {
    throw new PartnerError(
      `${statusUrl.href} answered ${response.status} with a body that is not the worker's JSON status: ${JSON.stringify(text.slice(0, 80))}. Check that CODEX_TOKEN_URL points at the token worker.`,
    );
  }

  return body;
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

if (import.meta.main) {
  await main(async () => {
    parseArguments(process.argv.slice(2), { usage: USAGE });

    printJson(await fetchStatus(process.env));
  });
}
