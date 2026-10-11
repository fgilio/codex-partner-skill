#!/usr/bin/env node
// Starts a named Codex partner session in this repository and prints its first reply.

import {
  PartnerError,
  assertPartnerName,
  findPartner,
  loadPartners,
  main,
  parseTurnArguments,
  printJson,
  readPrompt,
  repositoryRoot,
  runCodexTurn,
  updatePartners,
} from "./lib.mjs";

const USAGE = `Usage: codex-partner-start.mjs <name> [options] <prompt | ->

Starts a Codex session that remembers the conversation. Continue it with
codex-partner-say.mjs <name>. Names are scoped to the current repository.

Options:
  --model <id>       Codex model (default: the Codex config)
  --effort <level>   Reasoning effort (default: the Codex config)
  --write            Let Codex edit files and run any command, with no sandbox
  --mcp              Keep the MCP servers from the Codex config switched on

Pass - as the prompt to read it from stdin.
`;

main(async () => {
  const { positionals, options } = parseTurnArguments(
    process.argv.slice(2),
    USAGE,
  );
  const [name, promptArgument, ...extra] = positionals;

  assertPartnerName(name, USAGE);

  if (extra.length > 0) {
    throw new PartnerError(
      `Expected a name and one prompt argument. Quote the prompt.\n\n${USAGE}`,
    );
  }

  const directory = process.cwd();
  const repository = repositoryRoot();

  if (findPartner(loadPartners(), repository, name)) {
    throw new PartnerError(
      `A partner named "${name}" already exists in ${repository}. Continue it with codex-partner-say.mjs ${name}, or forget it first.`,
    );
  }

  const turn = await runCodexTurn({
    prompt: readPrompt(promptArgument, USAGE),
    options,
    directory,
  });

  if (!turn.threadId) {
    throw new PartnerError(
      "Codex replied without reporting a thread id, so the partner cannot be continued.",
    );
  }

  const now = new Date().toISOString();

  updatePartners((partners) => {
    if (findPartner(partners, repository, name)) {
      throw new PartnerError(
        `A partner named "${name}" was saved in ${repository} while Codex answered. This reply is on Codex thread ${turn.threadId}. Continue the saved partner with codex-partner-say.mjs ${name}, or forget it first.`,
      );
    }

    return [
      ...partners,
      {
        name,
        repository,
        directory,
        thread_id: turn.threadId,
        created_at: now,
        last_used_at: now,
      },
    ];
  });

  printJson({ name, thread_id: turn.threadId, reply: turn.reply });
});
