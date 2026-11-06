#!/usr/bin/env bun
// Sends the next message to a named Codex partner and prints its reply.

import {
  PartnerError,
  assertPartnerName,
  describeDefault,
  findPartner,
  holdPartnerLock,
  isPartner,
  loadPartners,
  main,
  parseTurnArguments,
  printResult,
  readPrompt,
  repositoryRoot,
  runCodexTurn,
  updatePartners,
  turnDefaults,
} from "./lib";

const defaults = turnDefaults.partner;

const USAGE = `Usage: codex-partner-say.ts <name> [options] <prompt | ->

Continues the partner session started with codex-partner-start.ts <name>.
Codex sees the whole conversation so far.

Options:
  --model <id>       Codex model (default: ${describeDefault(defaults.model)})
  --effort <level>   Reasoning effort (default: ${describeDefault(defaults.effort)})
  --write            Let Codex edit files and run any command, with no sandbox
  --mcp              Keep the MCP servers from the Codex config switched on
  --json             Print JSON with the name, thread id, and reply

Pass - as the prompt to read it from stdin.
`;

await main(async () => {
  const { positionals, options, asJson } = parseTurnArguments(
    process.argv.slice(2),
    USAGE,
    { defaults },
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
      `No partner named "${name}" exists in ${repository}. Start one with codex-partner-start.ts ${name} "<prompt>".`,
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

  printResult(
    { name, thread_id: partner.thread_id, reply: turn.reply },
    { asJson },
  );
});
