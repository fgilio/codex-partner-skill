---
name: codex-partner
description: >
  Talk with OpenAI Codex from Claude Code and put it to work: a one-shot question, a code review of the changes, or a named partner that remembers the conversation across turns and can take on an investigation, an implementation, or a design debate. Use when the user says ask Codex, get a second opinion from Codex, have Codex review the changes, pair with Codex, start a Codex partner, bounce this off Codex, delegate to Codex, put Codex to work, a Codex subagent, Codex partner, an adversarial second opinion from Codex, ponelo a laburar a Codex, delegá en Codex, que Codex lo revise, or names an existing partner. Works in local and cloud sessions.
argument-hint: "[ask | review | start <name> | say <name> | list | forget <name> | auth] <message>"
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/*)
---

# Codex Partner

Codex is a second agent with its own model and its own read of the repository. The user prefers that you delegate real work to it, not only questions. **Brief, then weigh**: brief it with what it can't find on its own, then check its answer against the code before anything reaches the user.

## Choose the mode

| The user wants | Mode | Script |
| --- | --- | --- |
| One answer, no follow-up | ask | `codex-partner-ask.ts` |
| Findings on a change: the uncommitted work, a branch, or one commit | review | `codex-partner-review.ts` |
| Work or a conversation that builds over turns: an investigation, an implementation, pairing, a design debate | partner | `codex-partner-start.ts` once, then `codex-partner-say.ts` |

- "Ask Codex whether this regex handles emoji" → ask.
- "Have Codex review my changes" → review. To work through the findings with Codex afterwards, review with `--as <name>`, which starts a new partner from the review, then use say. To discuss a diff with a partner that already exists, use say and point it at the diff.
- "Does Codex like this design?" → ask or a partner. A review reports only the defects a change adds.
- "Pair with Codex on the invoice export" → start a partner named `invoice-export`, then keep using say.
- "Implement the CSV writer from the agreed design, with tests" → start a partner with `--write` and the design as its brief.
- "Find out why the nightly export doubled in size since Tuesday" → start a partner that investigates and reports its cause with evidence.
- "What does Codex think now?" while a partner exists → say to that partner. A fresh ask would lose the context the partner already holds.

## Delegate

The user prefers that you put Codex to work as a subagent with its own opinions, and doesn't want a useful delegation skipped to save Codex tokens. This is a preference, not a rule to send everything to Codex.

Prefer handing Codex, early, a substantial part of the task that you can check on its own: an investigation, an implementation, a first draft. Give it the outcome, the scope, the constraints, and the acceptance criteria. Run it in the background and continue another part yourself while it works.

- Reuse a named partner while its context stays relevant. It answers one message at a time, so batch what changed into one message between turns rather than sending each fact.
- Start several partners when the task has independent fronts. When two of them write, give each its own files or its own worktree.
- A small self-contained question is still an ask.

## Commands

A failure prints its message on stderr and exits 1, and the message names the fix. When only the user can make that fix, such as a network secret or the worker's seed script, tell the user.

```bash
# One question in a throwaway session
${CLAUDE_SKILL_DIR}/scripts/codex-partner-ask.ts "Does the retry loop in app/Jobs/SendInvoice.php stop after five attempts? Answer yes or no, citing the line."

# Codex's code review of the uncommitted changes, or of the branch against the default branch when the tree is clean
${CLAUDE_SKILL_DIR}/scripts/codex-partner-review.ts
# → Target: uncommitted changes
#
#   <findings tagged P0 to P3, with file:line>

# Review the branch against main and keep it as a partner, so say can discuss the findings
${CLAUDE_SKILL_DIR}/scripts/codex-partner-review.ts --base main --as billing-review

# Instructions replace the target: Codex reviews what they describe
${CLAUDE_SKILL_DIR}/scripts/codex-partner-review.ts "Review the changes against main. Focus on the retry logic in app/Jobs."

# Start a partner
${CLAUDE_SKILL_DIR}/scripts/codex-partner-start.ts invoice-export - <<'EOF'
We are splitting app/Exports/InvoiceExport.php into a query object and a CSV writer.
Goal: exports of 100k invoices finish under a minute without loading every row into memory.
Read the class and its tests, then propose the split. List the risks first.
EOF

# Continue it
${CLAUDE_SKILL_DIR}/scripts/codex-partner-say.ts invoice-export "I took your split. Your risk 2 doesn't apply: the writer streams to a temp file. Re-check risk 3 against tests/Feature/InvoiceExportTest.php."

${CLAUDE_SKILL_DIR}/scripts/codex-partner-list.ts                  # this repository's partners, most recent first (--all: every repository)
${CLAUDE_SKILL_DIR}/scripts/codex-partner-forget.ts invoice-export # frees the name for a new conversation
${CLAUDE_SKILL_DIR}/scripts/codex-partner-auth.ts                  # where Codex gets its login
```

A message longer than one line, one that holds quotes, backticks, or `$`, or one that starts with a dash goes on stdin: pass `-` as the prompt and a quoted heredoc (`<<'EOF'`). Bun keeps a `--` for the script only when another argument comes before it, so `-- --prompt` alone reads as an option.

Options for ask, start, and say:

| Option | Effect |
| --- | --- |
| `--effort <level>` | Reasoning effort: `low`, `medium`, `high`, or `xhigh`. Defaults to `medium` for ask and `high` for start and say. |
| `--model <id>` | Codex model. Defaults to `gpt-6.1-sol`. |
| `--write` | Codex may edit files inside the repository and run commands, in its workspace-write sandbox with network off. |
| `--mcp` | Keeps the MCP servers of the Codex config switched on. They are off by default. |

Review takes `--effort`, `--model`, `--mcp`, `--base <branch>`, `--commit <sha>`, and `--as <name>`. Its effort defaults to `high`. It always runs read-only, and it takes a target or instructions, never both.

## Brief

Codex opens the same repository, but it never sees this conversation.

- Point at paths, branches, commands, and symptoms. Codex reads files and runs git itself.
- Add only what it can't fetch: the goal, the constraints, what you already tried, error output, and decisions the user made.
- Ask for a deliverable you can check: a verdict with evidence, a list of risks in order, a failing test case, a change that passes the tests.

```text
DON'T: Here is the diff: <300 pasted lines>. Thoughts?
DO:    Review the uncommitted changes under app/Billing (run git diff). Goal: a failed invoice email
       retries at most five times. The queue config is already confirmed. List bugs as file:line,
       most severe first.
```

A partner keeps the context, so each later message carries only what changed: what you applied, what you dispute and why, what to check next.

## Wait

- An ask at `medium` effort that Codex answers from a few files: run it in the foreground with `timeout: 600000`.
- A review, a partner turn, or a call that reads much of the repository or runs tests: run it with `run_in_background: true` and wait for the completion notification. Never poll with sleep.
- In a cloud session, a background command stops after 30 minutes unless the call passes a longer `timeout`, up to 2 hours.
- A partner answers one message at a time.

## Weigh

- Check each claim Codex makes against the code before you act on it or repeat it.
- When you disagree, say so in the next say and give your evidence. The partner holds the context, so a rebuttal takes one message.
- Report Codex's position, your own, and where they differ. Never present a Codex answer as settled fact.
- For a consequential decision only, ask the partner to try to falsify the claim against the code and give a counterexample or a stronger alternative, and to say explicitly when it found none.

When the evidence converges, report one position. Report two only when they differ.

## Edits

`--write` on an ask or a partner lets Codex implement inside the repository, in its sandbox. Use it when the user asked for an implementation that Codex can own, not only when the user named Codex. Review Codex's changes with `git diff` and the tests before you build on them. When you and a partner both edit, keep your files apart.

## Lifetime

- Partner names are per repository.
- A partner lives as long as the machine keeps Codex's session files (a rebuilt cloud VM loses them).
