#!/usr/bin/env bun
// Asks Codex one question in a throwaway session and prints the reply.

import {
  PartnerError,
  describeDefault,
  main,
  parseTurnArguments,
  printResult,
  readPrompt,
  runCodexTurn,
  turnDefaults,
} from "./lib";

const defaults = turnDefaults.ask;

const USAGE = `Usage: codex-partner-ask.ts [options] <prompt | ->

Asks Codex one question. Codex keeps no session, so a follow-up needs a partner.

Options:
  --model <id>       Codex model (default: ${describeDefault(defaults.model)})
  --effort <level>   Reasoning effort (default: ${describeDefault(defaults.effort)})
  --write            Let Codex edit files and run any command, with no sandbox
  --mcp              Keep the MCP servers from the Codex config switched on
  --json             Print JSON with the reply

Pass - as the prompt to read it from stdin.
`;

await main(async () => {
  const { positionals, options, asJson } = parseTurnArguments(
    process.argv.slice(2),
    USAGE,
    { defaults },
  );

  if (positionals.length > 1) {
    throw new PartnerError(
      `Expected one prompt argument, got ${positionals.length}. Quote the prompt.\n\n${USAGE}`,
    );
  }

  const turn = await runCodexTurn({
    prompt: readPrompt(positionals[0], USAGE),
    isEphemeral: true,
    options,
    directory: process.cwd(),
  });

  printResult({ reply: turn.reply }, { asJson });
});
