---
name: codex-partner
description: >
  Talk with OpenAI Codex from Claude Code: a one-shot second opinion, or a named partner that remembers the conversation across turns for pair programming, design debates, and iterative reviews. Use when the user says ask Codex, get a second opinion from Codex, pair with Codex, start a Codex partner, bounce this off Codex, or names an existing partner. Brief, then weigh. Read-only unless the user asks Codex to edit. Works in local and cloud sessions.
argument-hint: "[ask | start <name> | say <name> | list | forget <name>] <message>"
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/*)
---

# Codex Partner

Codex is a second agent with its own model and its own read of the repository. Work with it the way you work with a sharp colleague: **brief, then weigh**. Brief it with what it can't find on its own, then check its answer against the code before anything reaches the user.

## Choose the mode

| The user wants | Mode | Script |
| --- | --- | --- |
| One answer, no follow-up | ask | `codex-partner-ask.mjs` |
| A conversation that builds over turns: pairing, a design debate, an iterative review | partner | `codex-partner-start.mjs` once, then `codex-partner-say.mjs` |

- "Ask Codex whether this regex handles emoji" → ask.
- "Pair with Codex on the invoice export" → start a partner named `invoice-export`, then keep using say.
- "What does Codex think now?" while a partner exists → say to that partner. A fresh ask would lose the context the partner already holds.

## Commands

Every script prints JSON on stdout. A failure prints `{"error": "..."}` on stderr, exits 1, and the message names the fix.

```bash
# One question in a throwaway session
${CLAUDE_SKILL_DIR}/scripts/codex-partner-ask.mjs "Does the retry loop in app/Jobs/SendInvoice.php stop after five attempts? Answer yes or no, citing the line."
# → {"reply": "..."}

# Start a partner (name: 1 to 64 letters, digits, dots, dashes, or underscores)
${CLAUDE_SKILL_DIR}/scripts/codex-partner-start.mjs invoice-export - <<'EOF'
We are splitting app/Exports/InvoiceExport.php into a query object and a CSV writer.
Goal: exports of 100k invoices finish under a minute without loading every row into memory.
Read the class and its tests, then propose the split. List the risks first.
EOF
# → {"name": "invoice-export", "thread_id": "...", "reply": "..."}

# Continue it
${CLAUDE_SKILL_DIR}/scripts/codex-partner-say.mjs invoice-export "I took your split. Your risk 2 doesn't apply: the writer streams to a temp file. Re-check risk 3 against tests/Feature/InvoiceExportTest.php."
# → {"name": "invoice-export", "thread_id": "...", "reply": "..."}

${CLAUDE_SKILL_DIR}/scripts/codex-partner-list.mjs                  # this repository's partners, most recent first (--all: every repository)
${CLAUDE_SKILL_DIR}/scripts/codex-partner-forget.mjs invoice-export # frees the name for a new conversation
${CLAUDE_SKILL_DIR}/scripts/codex-partner-auth.mjs                  # where Codex gets its login
```

A message longer than one line, or one that holds quotes, backticks, or `$`, goes on stdin: pass `-` as the prompt and a quoted heredoc (`<<'EOF'`).

Options for ask, start, and say:

| Option | Effect |
| --- | --- |
| `--effort <level>` | Reasoning effort: `low`, `medium`, `high`, or `xhigh`. Ask defaults to `low`. Partners use the Codex config. |
| `--model <id>` | Codex model. Defaults to the Codex config. |
| `--write` | Codex may edit files and run any command, with no sandbox. |
| `--mcp` | Keeps the MCP servers of the Codex config switched on. They are off by default. |

## Brief

Codex opens the same repository, but it never sees this conversation.

- Point at paths, branches, commands, and symptoms. Codex reads files and runs git itself.
- Add only what it can't fetch: the goal, the constraints, what you already tried, error output, and decisions the user made.
- Ask for a deliverable you can check: a verdict with evidence, a list of risks in order, a failing test case.

```text
DON'T: Here is the diff: <300 pasted lines>. Thoughts?
DO:    Review the uncommitted changes under app/Billing (run git diff). Goal: a failed invoice email
       retries at most five times. The queue config is already confirmed. List bugs as file:line,
       most severe first.
```

A partner keeps the context, so each later message carries only what changed: what you applied, what you dispute and why, what to check next.

## Wait

- A question Codex answers from a few files: run it in the foreground with `timeout: 600000`.
- A call that reads much of the repository, runs tests, or uses `--effort high` or above: run it with `run_in_background: true` and wait for the completion notification. Never poll with sleep.
- In a cloud session, a background command stops after 30 minutes unless the call passes a longer `timeout`, up to 2 hours.
- A partner answers one message at a time. A second say to the same partner while one runs fails with "still answering".

## Weigh

- Check each claim Codex makes against the code before you act on it or repeat it.
- When you disagree, say so in the next say and give your evidence. The partner holds the context, so a rebuttal takes one message.
- Report Codex's position, your own, and where they differ. Never present a Codex answer as settled fact.

## Edits

Asks and partners run read-only: Codex reads files and runs commands that change nothing. Pass `--write` only when the user wants Codex to change files, then review its changes with `git diff` before you build on them.

## Lifetime

- Partner names are per repository.
- A partner lives as long as the machine keeps Codex's session files. When Codex no longer has the session, for example in a rebuilt cloud VM, say fails with a hint: forget the partner and start a new one with a recap.

## Cloud sessions

When `CODEX_TOKEN_URL` is set, each script fetches a short-lived Codex access token from the token worker before it calls Codex, and a SessionStart hook does the same so other Codex tools find a login. A login made with `codex login` always wins over the worker. Where the Codex sandbox can't start, the environment sets `CODEX_PARTNER_SANDBOX=bypass`.

## Errors

| The error mentions | Do this |
| --- | --- |
| `codex executable` | Install Codex: `npm install -g @openai/codex`. |
| `rejected the request (401)` | The cloud environment needs a network secret for the worker host. Tell the user. |
| `answered 503` | The worker holds no fresh login. Tell the user to run the worker's seed script. |
| `already exists` | Say to that partner, or forget it first. |
| `still answering` | Wait for the running call to finish. |
| `without a reply` | Read Codex's message. When it reports a missing session, forget the partner and start over with a recap. |
