# codex-partner skill

Talk with [OpenAI Codex](https://github.com/openai/codex) from Claude Code. Ask it for a one-shot second opinion, or start a named partner that remembers the conversation across turns, for pair programming, design debates, and iterative reviews. It runs in local sessions and in [Claude Code cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web).

Everything Claude follows lives in [SKILL.md](skills/codex-partner/SKILL.md).

```bash
codex-partner-ask.mjs "Does the retry loop stop after five attempts?"
codex-partner-start.mjs invoice-export "Read app/Exports and propose a split. Risks first."
codex-partner-say.mjs invoice-export "Your risk 2 doesn't apply. Re-check risk 3."
codex-partner-list.mjs
codex-partner-forget.mjs invoice-export
codex-partner-auth.mjs
```

Each partner is a Codex session resumed with `codex exec resume`, so it holds the whole conversation without a daemon, a terminal multiplexer, or an MCP server. Asks and partners run in Codex's read-only sandbox unless the call passes `--write`.

## Requirements

- The [Codex CLI](https://github.com/openai/codex) on `PATH`, signed in with `codex login` (or a [token worker](#cloud-sessions) in cloud sessions)
- Node.js 22 or later
- `git` and `curl`

## Installation

```
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
| `CODEX_TOKEN_BEARER` | The worker's serve token, for calls from outside a cloud session. Cloud sessions use a network secret instead. |

## Cloud sessions

A cloud session has no browser for `codex login`, and a ChatGPT login copied into many VMs breaks: each refresh rotates the refresh token, and the first VM to refresh spends it for every other copy. The [token worker](token-worker) holds one login on Cloudflare, is the only code that refreshes it, and serves clients only the short-lived access token.

Codex refreshes a token only in its last 5 minutes. The scripts fetch a new one once less than an hour is left, and the worker never serves a token closer to expiry than that, so a cloud VM never refreshes on its own.

```
claude.ai cloud session                     Cloudflare
├─ SessionStart hook / each script ──GET──▶ token worker (codex-token)
│  (network secret adds the serve token)    ├─ cron every 6 h: refresh when < 36 h left
├─ ~/.codex/auth.json  ◀── access token ──  └─ KV: login sealed with BUNDLE_KEY
└─ codex exec ───────────────────────────▶ chatgpt.com (your ChatGPT plan)
```

### 1. Deploy the worker

```bash
cd token-worker
export CLOUDFLARE_ACCOUNT_ID=<account id>
wrangler kv namespace create CODEX_AUTH        # put the id in wrangler.jsonc
wrangler deploy
openssl rand -hex 32                           # the serve token: keep it for step 3
wrangler secret put SERVE_TOKEN                # paste the serve token at the prompt
node scripts/seed.mjs                          # signs in to ChatGPT in the browser
```

`seed.mjs` signs in with `codex login` in a temporary Codex home, so the worker owns a login that no other machine refreshes, then seals it under a new `BUNDLE_KEY` secret.

### 2. Check it

```bash
CODEX_TOKEN_URL=https://<worker>/auth.json CODEX_TOKEN_BEARER=<serve token> node token-worker/scripts/status.mjs
```

A healthy worker reports an `access_expires_at` more than a day away and a `last_error` of `null`. When `last_error` names a failed refresh, run `seed.mjs` again.

### 3. Configure the cloud environment

In the environment dialog at [claude.ai/code](https://claude.ai/code):

- **Network access**: Custom, with the default list included, plus `chatgpt.com` and `api.openai.com`
- **Environment variables**: `CODEX_TOKEN_URL=https://<worker>/auth.json`
- **Network secrets**: one secret for the worker host, Bearer, with the serve token as the value
- **Setup script**:

  ```bash
  npm install -g @openai/codex || true
  claude plugin marketplace add fgilio/claude-plugins || true
  claude plugin install codex-partner@fgilio || true
  ```

  To install the other plugins of the [fgilio marketplace](https://github.com/fgilio/claude-plugins#cloud-sessions) too, use its `cloud-setup.sh` instead. A cloud environment reruns its setup script only when the script's text changes.

The network secret keeps the serve token outside the VM. Claude Code attaches it to requests for the worker host after they leave the session, and it never reaches setup-script requests, so the token fetch runs at session start through the plugin's SessionStart hook.

## Development

```bash
node --test 'test/*.test.mjs' 'token-worker/test/*.test.mjs'
```

The partner tests run the scripts against a fake `codex` on `PATH`. The worker tests run its handlers with an in-memory KV and a stubbed OpenAI token endpoint.

## License

[MIT](LICENSE)
