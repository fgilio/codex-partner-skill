#!/usr/bin/env node
// Sends the next message to a named Codex partner and prints its reply.

import {
  PartnerError,
  assertPartnerName,
  findPartner,
  holdPartnerLock,
  isPartner,
  loadPartners,
  main,
  parseTurnArguments,
  printJson,
  readPrompt,
  repositoryRoot,
  runCodexTurn,
  updatePartners,
} from "./lib.mjs";

const USAGE = `Usage: codex-partner-say.mjs <name> [options] <prompt | ->

Continues the partner session started with codex-partner-start.mjs <name>.
Codex sees the whole conversation so far.

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

  const repository = repositoryRoot();
  const partner = findPartner(loadPartners(), repository, name);

  if (!partner) {
    throw new PartnerError(
      `No partner named "${name}" exists in ${repository}. Start one with codex-partner-start.mjs ${name} "<prompt>".`,
    );
  }

  const prompt = readPrompt(promptArgument, USAGE);

  holdPartnerLock(partner.thread_id);

  const turn = await runCodexTurn({
    prompt,
    threadId: partner.thread_id,
    options,
    directory: partner.directory,
  });

  updatePartners((partners) =>
    partners.map((saved) =>
      isPartner(saved, repository, name)
        ? { ...saved, last_used_at: new Date().toISOString() }
        : saved,
    ),
  );

  printJson({ name, thread_id: partner.thread_id, reply: turn.reply });
});
