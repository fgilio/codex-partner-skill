#!/usr/bin/env bun
// Starts a named Codex partner session in this repository and prints its first reply.

import {
  PartnerError,
  assertNewPartner,
  assertPartnerName,
  describeDefault,
  main,
  parseTurnArguments,
  printResult,
  readPrompt,
  repositoryRoot,
  runCodexTurn,
  savePartner,
  turnDefaults,
} from "./lib";

const defaults = turnDefaults.partner;

const USAGE = `Usage: codex-partner-start.ts <name> [options] <prompt | ->

Starts a Codex session that remembers the conversation. Continue it with
codex-partner-say.ts <name>. Names are scoped to the current repository.

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

  const directory = process.cwd();
  const repository = repositoryRoot();

  assertNewPartner(repository, name);

  const turn = await runCodexTurn({
    prompt: readPrompt(promptArgument, USAGE),
    options,
    directory,
  });

  savePartner({ name, repository, directory, threadId: turn.threadId });

  printResult(
    { name, thread_id: turn.threadId, reply: turn.reply },
    { asJson },
  );
});
