#!/usr/bin/env node
// Asks Codex one question in a throwaway session and prints the reply.

import {
  PartnerError,
  main,
  parseArguments,
  printJson,
  readPrompt,
  runCodexTurn,
  turnOptions,
} from "./lib.mjs";

const USAGE = `Usage: codex-partner-ask.mjs [options] <prompt | ->

Asks Codex one question. Codex keeps no session, so a follow-up needs a partner.

Options:
  --model <id>       Codex model (default: CODEX_PARTNER_MODEL, then the Codex config)
  --effort <level>   Reasoning effort (default: CODEX_PARTNER_EFFORT, then low)
  --write            Let Codex edit files and run any command, with no sandbox
  --mcp              Keep the MCP servers from the Codex config switched on

Pass - as the prompt to read it from stdin.
`;

main(async () => {
  const { flags, positionals } = parseArguments(process.argv.slice(2), {
    usage: USAGE,
    valueFlags: ["model", "effort"],
    booleanFlags: ["write", "mcp"],
  });

  if (positionals.length > 1) {
    throw new PartnerError(
      `Expected one prompt argument, got ${positionals.length}. Quote the prompt.\n\n${USAGE}`,
    );
  }

  const turn = await runCodexTurn({
    prompt: readPrompt(positionals[0], USAGE),
    isEphemeral: true,
    options: turnOptions(flags, { defaultEffort: "low" }),
    directory: process.cwd(),
  });

  printJson({ reply: turn.reply });
});
