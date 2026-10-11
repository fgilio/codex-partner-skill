#!/usr/bin/env node
// Lists the Codex partners of this repository, most recently used first.

import {
  PartnerError,
  loadPartners,
  main,
  parseArguments,
  printJson,
  repositoryRoot,
} from "./lib.mjs";

const USAGE = `Usage: codex-partner-list.mjs [--all]

Lists the partners of the current repository as JSON, most recently used first.

Options:
  --all   List the partners of every repository
`;

main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    booleanFlags: ["all"],
  });

  if (positionals.length > 0) {
    throw new PartnerError(
      `codex-partner-list.mjs takes no arguments.\n\n${USAGE}`,
    );
  }

  const repository = repositoryRoot();
  const partners = loadPartners()
    .filter((partner) => flags.all || partner.repository === repository)
    .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at));

  printJson(partners);
});
