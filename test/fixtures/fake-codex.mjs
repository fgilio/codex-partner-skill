#!/usr/bin/env node
// Stands in for the Codex CLI: logs each call and answers like `codex exec --json`.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}

const stdin = readFileSync(0, "utf8");
const resumeIndex = args.indexOf("resume");
const threadId =
  resumeIndex === -1
    ? (process.env.FAKE_CODEX_THREAD_ID ?? "thread-new")
    : args[resumeIndex + 1];
const replyPath = args[args.indexOf("--output-last-message") + 1];

if (process.env.FAKE_CODEX_LOG) {
  appendFileSync(
    process.env.FAKE_CODEX_LOG,
    `${JSON.stringify({ args, stdin, cwd: process.cwd() })}\n`,
  );
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (process.env.FAKE_CODEX_MODE === "fail") {
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.failed", error: { message: "model overloaded" } });
  process.exit(1);
}

if (process.env.FAKE_CODEX_MODE !== "no-thread") {
  emit({ type: "thread.started", thread_id: threadId });
}

const reply = `reply to: ${stdin.trim()}`;

emit({
  type: "item.completed",
  item: { id: "item_1", type: "agent_message", text: reply },
});
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
writeFileSync(replyPath, reply);
