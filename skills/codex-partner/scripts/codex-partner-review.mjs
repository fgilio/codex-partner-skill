#!/usr/bin/env node
// Runs Codex's built-in code review on this repository and prints the findings.

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
  runCodexReview,
  savePartner,
} from "./lib.mjs";

const USAGE = `Usage: codex-partner-review.mjs [options] [instructions | -]

Runs Codex's code review, read-only. With no target and no instructions, it
reviews the uncommitted changes, or the current branch against the default
branch when the working tree is clean.

Options:
  --base <branch>    Review the changes against this branch
  --commit <sha>     Review the changes of one commit
  --as <name>        Keep the review as a partner, to continue with codex-partner-say.mjs <name>
  --model <id>       Codex model (default: the Codex config)
  --effort <level>   Reasoning effort (default: the Codex config)
  --mcp              Keep the MCP servers from the Codex config switched on
  --json             Print JSON with the target and reply, plus the name and thread id with --as

Instructions replace the target: Codex reviews what they describe, such as
"Review the changes against main. Focus on the retry logic." Pass - to read
them from stdin.
`;

main(async () => {
  const { flags, positionals, options, asJson } = parseTurnArguments(
    process.argv.slice(2),
    USAGE,
    { valueFlags: ["base", "commit", "as"], allowsWrite: false },
  );

  if (positionals.length > 1) {
    throw new PartnerError(
      `Expected one instructions argument, got ${positionals.length}. Quote the instructions.\n\n${USAGE}`,
    );
  }

  if (flags.base !== undefined && flags.commit !== undefined) {
    throw new PartnerError(`Pass --base or --commit, not both.\n\n${USAGE}`);
  }

  const hasInstructions = positionals.length === 1;

  if (
    hasInstructions &&
    (flags.base !== undefined || flags.commit !== undefined)
  ) {
    throw new PartnerError(
      'Codex reviews a target (--base or --commit) or follows instructions, not both. Name the target in the instructions instead, such as "Review the changes against main. Focus on the retry logic."',
    );
  }

  const name = flags.as;
  const directory = process.cwd();
  const repository = repositoryRoot();

  if (name !== undefined) {
    assertPartnerName(name, USAGE);
    assertNewPartner(repository, name);
  }

  const instructions = hasInstructions
    ? readPrompt(positionals[0], USAGE)
    : undefined;
  const target = hasInstructions
    ? { label: "custom instructions", arguments: ["-"] }
    : resolveTarget(flags);

  const review = await runCodexReview({
    target: target.arguments,
    instructions,
    isEphemeral: name === undefined,
    options,
    directory,
  });

  if (name !== undefined) {
    savePartner({ name, repository, directory, threadId: review.threadId });
  }

  printResult(
    {
      ...(name === undefined ? {} : { name, thread_id: review.threadId }),
      target: target.label,
      reply: review.reply,
    },
    { asJson, header: `Target: ${target.label}` },
  );
});

function resolveTarget({ base, commit }) {
  if (git("rev-parse", "--is-inside-work-tree").stdout.trim() !== "true") {
    throw new PartnerError(
      `${process.cwd()} is not inside a git repository, so there are no changes to review. Run the review from the repository, or pass instructions that describe what to review.`,
    );
  }

  if (commit !== undefined) {
    if (!isCommit(commit)) {
      throw new PartnerError(
        `Unable to find the commit "${commit}" in this repository.`,
      );
    }

    return { label: `commit ${commit}`, arguments: ["--commit", commit] };
  }

  if (base !== undefined) {
    if (!isCommit(base)) {
      throw new PartnerError(
        `Unable to find the base branch "${base}" in this repository. Fetch it, or pass a branch that exists.`,
      );
    }

    return { label: `changes against ${base}`, arguments: ["--base", base] };
  }

  // Untracked files count, as they do for `codex review --uncommitted`,
  // whatever status.showUntrackedFiles says.
  if (git("status", "--porcelain", "--untracked-files=normal").stdout.trim()) {
    return { label: "uncommitted changes", arguments: ["--uncommitted"] };
  }

  const defaultBranch = findDefaultBranch();

  if (
    git("rev-list", "--count", `${defaultBranch}..HEAD`).stdout.trim() === "0"
  ) {
    throw new PartnerError(
      `Nothing to review: the working tree is clean, and HEAD has no commits that ${defaultBranch} lacks. Pass --base <branch>, or --commit <sha> to review one commit.`,
    );
  }

  return {
    label: `changes against ${defaultBranch}`,
    arguments: ["--base", defaultBranch],
  };
}

// origin/HEAD names the branch pull requests merge into. A clone without
// it, or with one that points at a deleted branch, falls back to the usual
// default branch names.
function findDefaultBranch() {
  const remoteHead = git(
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ).stdout.trim();
  const defaultBranch = [
    remoteHead,
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].find((ref) => ref && isCommit(ref));

  if (!defaultBranch) {
    throw new PartnerError(
      "Unable to find the default branch: this repository has no origin/HEAD, main, or master. Pass --base <branch>.",
    );
  }

  return defaultBranch;
}

function isCommit(ref) {
  return (
    git(
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ).status === 0
  );
}

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });

  if (result.error?.code === "ENOENT") {
    throw new PartnerError(
      "Unable to find git on PATH. Install git, then try again.",
    );
  }

  return result;
}
