#!/usr/bin/env node
// Starts a named Codex partner session in this repository and prints its first reply.

import {
  PartnerError,
  TURN_FLAGS,
  assertPartnerName,
  findSession,
  isPartner,
  loadSessions,
  main,
  parseArguments,
  printJson,
  readPrompt,
  repositoryRoot,
  runCodexTurn,
  turnOptions,
  updateSessions,
} from "./lib.mjs";

const USAGE = `Usage: codex-partner-start.mjs <name> [options] <prompt | ->

Starts a Codex session that remembers the conversation. Continue it with
codex-partner-say.mjs <name>. Names are scoped to the current repository.

Options:
  --model <id>       Codex model (default: CODEX_PARTNER_MODEL, then the Codex config)
  --effort <level>   Reasoning effort (default: CODEX_PARTNER_EFFORT, then the Codex config)
  --write            Let Codex edit files and run any command, with no sandbox
  --mcp              Keep the MCP servers from the Codex config switched on

Pass - as the prompt to read it from stdin.
`;

main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    ...TURN_FLAGS,
  });
  const [name, promptArgument, ...extra] = positionals;

  assertPartnerName(name, USAGE);

  if (extra.length > 0) {
    throw new PartnerError(
      `Expected a name and one prompt argument. Quote the prompt.\n\n${USAGE}`,
    );
  }

  const directory = process.cwd();
  const repository = repositoryRoot();

  if (findSession(loadSessions(), repository, name)) {
    throw new PartnerError(
      `A partner named "${name}" already exists in ${repository}. Continue it with codex-partner-say.mjs ${name}, or forget it first.`,
    );
  }

  const turn = await runCodexTurn({
    prompt: readPrompt(promptArgument, USAGE),
    options: turnOptions(flags),
    directory,
  });

  if (!turn.threadId) {
    throw new PartnerError(
      "Codex replied without reporting a session id, so the partner cannot be continued.",
    );
  }

  const now = new Date().toISOString();

  updateSessions((sessions) => [
    ...sessions.filter((session) => !isPartner(session, repository, name)),
    {
      name,
      repository,
      directory,
      thread_id: turn.threadId,
      created_at: now,
      last_used_at: now,
    },
  ]);

  printJson({ name, thread_id: turn.threadId, reply: turn.reply });
});
