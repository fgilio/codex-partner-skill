#!/usr/bin/env bun
// Forgets a named Codex partner of this repository.

import {
  PartnerError,
  assertPartnerName,
  findPartner,
  isPartner,
  loadPartners,
  main,
  parseArguments,
  printJson,
  repositoryRoot,
  updatePartners,
} from "./lib";

const USAGE = `Usage: codex-partner-forget.ts <name>

Removes the partner from this repository's list, so the name can start a new
conversation. The Codex session file stays in the Codex home.
`;

await main(async () => {
  const { positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
  });
  const [name, ...extra] = positionals;

  assertPartnerName(name, USAGE);

  if (extra.length > 0) {
    throw new PartnerError(
      `codex-partner-forget.ts takes one name.\n\n${USAGE}`,
    );
  }

  const repository = repositoryRoot();
  const partner = findPartner(loadPartners(), repository, name);

  if (!partner) {
    throw new PartnerError(
      `No partner named "${name}" exists in ${repository}. List them with codex-partner-list.ts.`,
    );
  }

  updatePartners((partners) =>
    partners.filter((saved) => !isPartner(saved, repository, name)),
  );

  printJson({ name, thread_id: partner.thread_id, forgotten: true });
});
