#!/usr/bin/env node
// Forgets a named Codex partner of this repository.

import {
  PartnerError,
  assertPartnerName,
  findSession,
  loadSessions,
  main,
  parseArguments,
  printJson,
  repositoryRoot,
  updateSessions,
} from "./lib.mjs";

const USAGE = `Usage: codex-partner-forget.mjs <name>

Removes the partner from this repository's list, so the name can start a new
conversation. The Codex session file stays in the Codex home.
`;

main(async () => {
  const { positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
  });
  const [name, ...extra] = positionals;

  assertPartnerName(name, USAGE);

  if (extra.length > 0) {
    throw new PartnerError(
      `codex-partner-forget.mjs takes one name.\n\n${USAGE}`,
    );
  }

  const repository = repositoryRoot();
  const session = findSession(loadSessions(), repository, name);

  if (!session) {
    throw new PartnerError(
      `No partner named "${name}" exists in ${repository}. List them with codex-partner-list.mjs.`,
    );
  }

  updateSessions((sessions) =>
    sessions.filter(
      (saved) => !(saved.repository === repository && saved.name === name),
    ),
  );

  printJson({ forgotten: name, thread_id: session.thread_id });
});
