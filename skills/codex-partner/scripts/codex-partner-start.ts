#!/usr/bin/env bun
// Starts a named Codex partner session in this repository and prints its first reply.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

import {
  type CodexResult,
  PartnerError,
  assertNewPartner,
  assertPartnerName,
  main,
  partnerHome,
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
  --worktree         Run the partner in a Git worktree of its own under $XDG_STATE_HOME/codex-partner/worktrees (or ~/.local/state/codex-partner/worktrees), so the checkout stays clean. The worktree stays after forget; remove it with git worktree remove
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

  const repository = repositoryRoot();

  assertNewPartner(repository, name);

  const prompt = readPrompt(promptArgument, USAGE);
  const directory = inWorktree
    ? addWorktree(repository, worktreePath(repository, name))
    : process.cwd();

  let turn: CodexResult;

  try {
    turn = await runCodexTurn({ prompt, options, directory });
  } catch (error) {
    if (inWorktree) {
      removeWorktree(repository, directory);
    }

    throw error;
  }

  savePartner({ name, repository, directory, threadId: turn.threadId });

  printResult(
    { name, thread_id: turn.threadId, reply: turn.reply },
    { asJson },
  );
});

/**
 * One directory per checkout, so two checkouts that share a basename
 * never hand a partner the same path.
 */
function worktreePath(repository: string, name: string): string {
  const hash = createHash("sha256").update(repository).digest("hex");

  return join(
    partnerHome(),
    "worktrees",
    `${basename(repository)}-${hash.slice(0, 8)}`,
    name,
  );
}

function addWorktree(repository: string, path: string): string {
  const result = spawnSync(
    "git",
    ["worktree", "add", "--detach", path, "HEAD"],
    { cwd: repository, encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new PartnerError(
      `Could not create the worktree ${path}: ${result.stderr.trim()}\nIf an earlier partner of this name left it behind, remove it with git worktree remove ${path}, or run git worktree prune when the directory is already gone.`,
    );
  }

  return path;
}

function removeWorktree(repository: string, path: string): void {
  spawnSync("git", ["worktree", "remove", "--force", path], {
    cwd: repository,
  });
}
