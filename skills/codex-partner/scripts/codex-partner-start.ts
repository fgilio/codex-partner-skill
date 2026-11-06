#!/usr/bin/env bun
// Starts a named Codex partner session in this repository and prints its first reply.

import { spawnSync } from "node:child_process";

import {
  PartnerError,
  assertNewPartner,
  assertPartnerName,
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
  --model <id>       Codex model (default: ${defaults.model})
  --effort <level>   Reasoning effort (default: ${defaults.effort})
  --write            Let Codex edit files inside the repository, in its workspace-write sandbox with network off
  --worktree         Run the partner in a Git worktree of its own under ~/.codex/worktrees, so the checkout stays clean. The worktree stays after forget; remove it with git worktree remove
  --mcp              Keep the MCP servers from the Codex config switched on
  --json             Print JSON with the name, thread id, and reply

Pass - as the prompt to read it from stdin.
`;

await main(async () => {
  const { positionals, switches, options, asJson } = parseTurnArguments(
    process.argv.slice(2),
    USAGE,
    { defaults, booleanFlags: ["worktree"] },
  );
  const inWorktree = switches.has("worktree");
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

  const worktreesBefore = inWorktree ? worktreePaths(directory) : [];
  const turn = await runCodexTurn({
    prompt: readPrompt(promptArgument, USAGE),
    inWorktree,
    options,
    directory,
  });

  savePartner({
    name,
    repository,
    directory: inWorktree
      ? newWorktree(worktreesBefore, worktreePaths(directory), turn.threadId)
      : directory,
    threadId: turn.threadId,
  });

  printResult(
    { name, thread_id: turn.threadId, reply: turn.reply },
    { asJson },
  );
});

function worktreePaths(directory: string): string[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: directory,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new PartnerError(
      `--worktree needs a git repository, and ${directory} is not inside one.`,
    );
  }

  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/**
 * The worktree Codex created for the first turn. Its id is Codex's own,
 * so the only way to find it is the one entry git did not list before.
 */
function newWorktree(
  before: string[],
  after: string[],
  threadId: string | undefined,
): string {
  const added = after.filter((path) => !before.includes(path));
  const [worktree] = added;

  if (worktree === undefined || added.length > 1) {
    throw new PartnerError(
      `Codex replied on thread ${threadId ?? "(unknown)"}, but ${added.length === 0 ? "no new git worktree appeared" : `${added.length} new git worktrees appeared (${added.join(", ")})`}, so the partner was not saved. Check git worktree list, then start the partner again.`,
    );
  }

  return worktree;
}
