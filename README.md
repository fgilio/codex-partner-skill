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
- Node.js 18 or later
- `git` and `curl`

## Installation

```
/plugin marketplace add fgilio/claude-plugins
/plugin install codex-partner@fgilio
```

Installed as a plugin, the skill runs as `/codex-partner:codex-partner`, and Claude also picks it up when you ask for Codex's opinion.

## Configuration

| Variable | Effect |
| --- | --- |
| `CODEX_PARTNER_MODEL` | Default Codex model. Without it, the Codex config decides. |
| `CODEX_PARTNER_EFFORT` | Default reasoning effort. Without it, asks use `low` and partners use the Codex config. |
| `CODEX_PARTNER_SANDBOX` | `read-only` (default) or `bypass`, for machines where the Codex sandbox can't start. |
| `CODEX_PARTNER_HOME` | Where the partner list lives. Defaults to `$XDG_STATE_HOME/codex-partner` or `~/.local/state/codex-partner`. |
| `CODEX_TOKEN_URL` | The token worker's `/auth.json` URL. Set only in cloud environments. |
| `CODEX_TOKEN_BEARER` | The worker's serve token, for calls from outside a cloud session. Cloud sessions use a network secret instead. |

MCP servers from the Codex config stay off for every call unless it passes `--mcp`, so an OAuth server can't open a browser in the middle of a turn.

## Cloud sessions

A cloud session has no browser for `codex login`, and a ChatGPT login copied into many VMs breaks: each refresh rotates the refresh token, and the first VM to refresh spends it for every other copy. The [token worker](token-worker) keeps one dedicated login on Cloudflare, refreshes it on a schedule as its only refresher, and serves just the short-lived access token. Codex refreshes a token only in its last 5 minutes, and the scripts fetch a new one an hour before that, so a cloud VM never refreshes on its own.

```
claude.ai cloud session                     Cloudflare
├─ SessionStart hook / each script ──GET──▶ codex-token worker
│  (network secret adds the bearer)         ├─ cron every 6 h: refresh when < 36 h left
├─ ~/.codex/auth.json  ◀── access token ──  └─ KV: login sealed with BUNDLE_KEY
└─ codex exec ───────────────────────────▶ chatgpt.com (your ChatGPT plan)
```

### 1. Deploy the worker

```bash
cd token-worker
export CLOUDFLARE_ACCOUNT_ID=<account id>
wrangler kv namespace create CODEX_AUTH        # put the id in wrangler.jsonc
wrangler deploy
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > serve-token
wrangler secret put SERVE_TOKEN < serve-token  # keep the value for step 3, then delete the file
node scripts/seed.mjs                          # signs in to ChatGPT in the browser
```

`seed.mjs` signs in with `codex login` in a temporary Codex home, so the worker owns a login that no other machine refreshes, then seals it under a new `BUNDLE_KEY` secret. Run it again whenever `/status` reports a refresh failure.

### 2. Check it

```bash
CODEX_TOKEN_URL=https://<worker>/auth.json CODEX_TOKEN_BEARER=<serve token> node token-worker/scripts/status.mjs
```

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

The network secret keeps the serve token outside the VM. Claude Code attaches it to requests for the worker host after they leave the session, and it never reaches setup-script requests, so the token fetch runs at session start through the plugin's SessionStart hook.

## Development

```bash
node --test 'test/*.test.mjs' 'token-worker/test/*.test.mjs'
```

The partner tests run the scripts against a fake `codex` on `PATH`. The worker tests run its handlers with an in-memory KV and a stubbed OpenAI token endpoint.

## License

[MIT](LICENSE)
