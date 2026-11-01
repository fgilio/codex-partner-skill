# codex-partner skill

Talk with [OpenAI Codex](https://github.com/openai/codex) from Claude Code. Ask it for a one-shot second opinion, have it review your changes, or start a named partner that remembers the conversation across turns, for pair programming, design debates, and iterative reviews. It runs in local sessions and in [Claude Code cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web).

Everything Claude follows lives in [SKILL.md](skills/codex-partner/SKILL.md).

```bash
codex-partner-ask.ts "Does the retry loop stop after five attempts?"
codex-partner-review.ts --base main
codex-partner-start.ts invoice-export "Read app/Exports and propose a split. Risks first."
codex-partner-say.ts invoice-export "Your risk 2 doesn't apply. Re-check risk 3."
codex-partner-list.ts
codex-partner-forget.ts invoice-export
codex-partner-auth.ts
```

Each partner is a Codex session resumed with `codex exec resume`, so it holds the whole conversation without a daemon, a terminal multiplexer, or an MCP server. Asks and partners run in Codex's read-only sandbox unless the call passes `--write`. Reviews use Codex's built-in reviewer (`codex exec review`) and always run read-only.

## Requirements

- The [Codex CLI](https://github.com/openai/codex) on `PATH`, signed in with `codex login` (or a [token worker](#cloud-sessions) in cloud sessions). Codex itself is a Node.js program, installed with `npm install -g @openai/codex`.
- [Bun](https://bun.sh) 1.4 or later, which runs the scripts. Claude Code cloud sessions ship with it.
- `git` and `curl`

## Installation

```text
/plugin marketplace add fgilio/claude-plugins
/plugin install codex-partner@fgilio
```

Installed as a plugin, the skill runs as `/codex-partner:codex-partner`, and Claude also picks it up when you ask for Codex's opinion.

## Configuration

Codex's own config sets the model and reasoning effort unless a call passes `--model` or `--effort`. Asks default to `low` effort.

MCP servers from the Codex config stay off for every call unless it passes `--mcp`, so an OAuth server can't open a browser in the middle of a turn.

The partner list lives in `$XDG_STATE_HOME/codex-partner`, or `~/.local/state/codex-partner` when `XDG_STATE_HOME` is unset.

| Variable | Effect |
| --- | --- |
| `CODEX_TOKEN_URL` | The token worker's `/auth.json` URL. Set only in cloud environments. |
| `CODEX_TOKEN_BEARER` | The worker's serve token. A cloud environment sets it through a network secret, so the session holds only a placeholder. Without it the worker answers 401. |

## Cloud sessions

A cloud session has no browser for `codex login`, and a ChatGPT login copied into many VMs breaks: each refresh rotates the refresh token, and the first VM to refresh spends it for every other copy. The [token worker](token-worker) holds one login on Cloudflare, is the only code that refreshes it, and serves clients only the short-lived access token.

Codex refreshes a token only in its last 5 minutes. The scripts fetch a new one once less than an hour is left, and the worker never serves a token closer to expiry than that, so a cloud VM never refreshes on its own.

```text
claude.ai cloud session                     Cloudflare
├─ SessionStart hook / each script ──GET──▶ token worker (codex-token)
│  (network secret swaps in the serve token)├─ cron every 6 h: refresh when < 36 h left
├─ ~/.codex/auth.json  ◀── access token ──  └─ KV: login sealed with BUNDLE_KEY
└─ codex exec ───────────────────────────▶ chatgpt.com (your ChatGPT plan)
```

### 1. Deploy the worker

```bash
bun install                                    # the wrangler that bun.lock pins
cd token-worker
export CLOUDFLARE_ACCOUNT_ID=<account id>
bun run wrangler kv namespace create CODEX_AUTH  # put the id in wrangler.jsonc
bun run wrangler deploy
openssl rand -hex 32                           # the serve token: keep it for step 3
bun run wrangler secret put SERVE_TOKEN        # paste the serve token at the prompt
bun scripts/seed.ts                            # signs in to ChatGPT in the browser
```

`bun run wrangler` runs the wrangler that `package.json` pins, and `seed.ts` calls the same one.

`seed.ts` signs in with `codex login` in a temporary Codex home, so the worker owns a login that no other machine refreshes, then seals it under a new `BUNDLE_KEY` secret.

### 2. Check it

From the same `token-worker` directory:

```bash
CODEX_TOKEN_URL=https://<worker>/auth.json CODEX_TOKEN_BEARER=<serve token> bun scripts/status.ts
```

A healthy worker reports an `access_expires_at` more than a day away and a `last_error` of `null`. When `last_error` names a failed refresh, run `seed.ts` again.

### 3. Configure the cloud environment

In the environment dialog at [claude.ai/code](https://claude.ai/code):

- **Network access**: Custom, with the default list included, plus `chatgpt.com` and `api.openai.com`
- **Environment variables**: `CODEX_TOKEN_URL=https://<worker>/auth.json`
- **Network secrets**: one secret for the worker host, exposed as `CODEX_TOKEN_BEARER`, with the serve token as the value
- **Setup script**:

  ```bash
  npm install -g @openai/codex || true
  claude plugin marketplace add fgilio/claude-plugins || true
  claude plugin install codex-partner@fgilio || true
  ```

  To install the other plugins of the [fgilio marketplace](https://github.com/fgilio/claude-plugins#cloud-sessions) too, use its `cloud-setup.sh` instead. A cloud environment reruns its setup script only when the script's text changes.

The network secret keeps the serve token outside the VM. Claude Code puts the token in the `Authorization` header of every request to the worker's host once the request leaves the session, so the session holds at most the placeholder in `CODEX_TOKEN_BEARER`, which the scripts send as the bearer when it is set. The swap never reaches setup-script requests, so the token fetch runs at session start through the plugin's SessionStart hook. A session reads its environment when it starts, so a session older than the secret keeps failing until you start a new one.

## Development

The scripts and the token worker are TypeScript that Bun runs as written, with no build step. The repository follows the fleet standard of the [fgilio plugin marketplace](https://github.com/fgilio/claude-plugins/blob/main/fleet/README.md): oxfmt, type-aware oxlint, `tsc`, markdownlint and `bun test`, with the same gates in CI.

```bash
bun install      # the tools at the versions bun.lock pins, and the pre-commit hook
bun run check    # format, lint, type check, Markdown lint, and every test
```

`bun install` installs a lefthook pre-commit hook. On the staged files it runs `oxlint --fix` and oxfmt on TypeScript, oxfmt on JSON, Markdown and YAML, and markdownlint on Markdown, and it adds their fixes to the commit. A lint error the fixer cannot fix stops the commit. Never bypass it with `--no-verify`. The prose rules run in CI from the marketplace's `check-prose.ts`.

The partner tests run the scripts against a fake `codex` on `PATH`. The worker tests run its handlers with an in-memory KV and a stubbed OpenAI token endpoint, and the seed and status scripts run against a fake `wrangler` and a local server. To check the worker bundle without deploying it, run `bun run wrangler deploy --dry-run --outdir <dir>` in `token-worker`.

## License

[MIT](LICENSE)
