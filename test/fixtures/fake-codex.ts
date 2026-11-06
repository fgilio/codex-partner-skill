#!/usr/bin/env bun
// Stands in for the Codex CLI: logs each call and answers like `codex exec --json`.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const args = process.argv.slice(2);

const stdin = readFileSync(0, "utf8");
const resumeIndex = args.indexOf("resume");
const reviewIndex = args.indexOf("review");
const threadId =
  resumeIndex === -1
    ? (process.env.FAKE_CODEX_THREAD_ID ?? "thread-new")
    : args[resumeIndex + 1];
const replyFlag = args.indexOf("--output-last-message");
const replyPath = replyFlag === -1 ? undefined : args[replyFlag + 1];

if (
  args.includes("--worktree") &&
  process.env.FAKE_CODEX_MODE !== "no-worktree"
) {
  enterNewWorktree();
}

if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    `${JSON.stringify({ args, stdin, cwd: process.cwd() })}\n`,
  );
}

const emit = (event: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);

if (process.env.FAKE_CODEX_MODE === "fail") {
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.failed", error: { message: "model overloaded" } });
  process.exit(1);
}

if (process.env.FAKE_CODEX_MODE !== "no-thread") {
  emit({ type: "thread.started", thread_id: threadId });
}

if (process.env.FAKE_CODEX_DELAY_MS) {
  await Bun.sleep(Number(process.env.FAKE_CODEX_DELAY_MS));
}

const reply =
  reviewIndex === -1
    ? `reply to: ${stdin.trim()}`
    : `review of: ${[...args.slice(reviewIndex + 1), stdin.trim()].filter(Boolean).join(" ")}`;

emit({
  type: "item.completed",
  item: { id: "item_1", type: "agent_message", text: reply },
});
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });

if (replyPath === undefined) {
  throw new Error("fake codex: --output-last-message is missing");
}

writeFileSync(replyPath, reply);

/**
 * Like Codex, puts a detached worktree of the current repository under an
 * unpredictable id and runs the turn there.
 */
function enterNewWorktree(): void {
  const worktrees = process.env.FAKE_CODEX_WORKTREES;

  if (!worktrees) {
    throw new Error("fake codex: --worktree needs FAKE_CODEX_WORKTREES");
  }

  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  const path = join(
    worktrees,
    crypto.randomUUID().slice(0, 8),
    basename(top.stdout.trim()),
  );
  const added = spawnSync("git", ["worktree", "add", "--detach", path], {
    encoding: "utf8",
  });

  if (top.status !== 0 || added.status !== 0) {
    throw new Error(`fake codex: git worktree add failed: ${added.stderr}`);
  }

  process.chdir(path);
}
