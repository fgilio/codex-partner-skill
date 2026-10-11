#!/usr/bin/env node
// Sends the next message to a named Codex partner and prints its reply.

import {
  PartnerError,
  TURN_FLAGS,
  assertPartnerName,
  findSession,
  holdPartnerLock,
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

const USAGE = `Usage: codex-partner-say.mjs <name> [options] <prompt | ->

Continues the partner session started with codex-partner-start.mjs <name>.
Codex sees the whole conversation so far.

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

  const repository = repositoryRoot();
  const session = findSession(loadSessions(), repository, name);

  if (!session) {
    throw new PartnerError(
      `No partner named "${name}" exists in ${repository}. Start one with codex-partner-start.mjs ${name} "<prompt>".`,
    );
  }

  const prompt = readPrompt(promptArgument, USAGE);

  holdPartnerLock(session.thread_id);

  const turn = await runCodexTurn({
    prompt,
    threadId: session.thread_id,
    options: turnOptions(flags),
    directory: session.directory,
  });

  updateSessions((sessions) =>
    sessions.map((saved) =>
      isPartner(saved, repository, name)
        ? { ...saved, last_used_at: new Date().toISOString() }
        : saved,
    ),
  );

  printJson({ name, thread_id: session.thread_id, reply: turn.reply });
});
