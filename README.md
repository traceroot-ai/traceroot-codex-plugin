# traceroot-codex-plugin

Trace OpenAI Codex sessions to [TraceRoot](https://traceroot.ai). Every query becomes **one live trace** — agent turn, model calls, tool calls, file edits, and any subagents it spawns — streamed as the agent works and linked to your git repo. No daemon; tracing never blocks Codex.

## Install

Add the marketplace, then install the plugin from it:

```bash
codex plugin marketplace add traceroot-ai/traceroot-codex-plugin
codex plugin add tracing@traceroot-codex-plugin
```

Enable Codex hooks (the plugin runs as a hook):

```bash
codex features enable hooks
```

This writes `features.hooks = true` to `~/.codex/config.toml`. The `codex plugin add` step above also enables the plugin there:

```toml
features.hooks = true

[plugins."tracing@traceroot-codex-plugin"]
enabled = true
```

Trust the plugin's hooks. Codex won't run a plugin's hooks until you've reviewed and trusted them, and installing the plugin doesn't do that for you. The reason it asks: hooks run as your user, outside Codex's sandbox. What you're trusting here is three hook definitions in [`plugins/tracing/hooks/hooks.json`](plugins/tracing/hooks/hooks.json) (`PostToolUse`, `Stop`, `SubagentStop`), each running `node "$PLUGIN_ROOT/dist/index.mjs"`. That script reads the session transcript and sends spans to your TraceRoot host; it writes nothing back into Codex and fails open. Source is in [`plugins/tracing/src/`](plugins/tracing/src/).

Start `codex`. At the "Hooks need review" prompt, choose **Trust all and continue** if you've looked at the above, or **Continue without trusting (hooks won't run)** and review them first under `/hooks`. Note that "all" means every hook awaiting review, not only this plugin's. Codex records a hash of each hook definition in `~/.codex/config.toml`, so you're asked once per definition and again if `hooks.json` changes; the hash does not cover `dist/index.mjs`, so a plugin update that changes the script runs under the existing grant. See [Codex hooks](https://developers.openai.com/codex/hooks).

Running Codex non-interactively (`codex exec`, the SDK, CI, containers)? There is no prompt there and untrusted hooks are skipped without an error. See [Headless runs](#headless-runs).

## Configure

Add `~/.codex/traceroot.json` — that's all that's required:

```json
{
  "enabled": true,
  "api_key": "your-key-from-app.traceroot.ai"
}
```

Get your API key at [app.traceroot.ai](https://app.traceroot.ai). (The plugin runs as a Codex hook, which doesn't reliably inherit your shell environment, so the config file is preferred over environment variables.)

<details>
<summary>Optional settings</summary>

Resolved highest-precedence first: env vars → project `.codex/traceroot.json` → global `~/.codex/traceroot.json` → defaults.

| JSON key | Env var | Default | Notes |
|----------|---------|---------|-------|
| `enabled` | `TRACE_TO_TRACEROOT` | `false` | Turn tracing on (an API key must also be set). |
| `api_key` | `TRACEROOT_API_KEY` | — | Required. |
| `host_url` | `TRACEROOT_HOST_URL` | `https://app.traceroot.ai` | Point at a self-hosted instance. |
| `max_chars` | `TRACEROOT_CODEX_MAX_CHARS` | `20000` | Truncate long span attributes. |
| `max_request_bytes` | `TRACEROOT_CODEX_MAX_REQUEST_BYTES` | `12582912` (12 MiB) | Target for the estimated size of one upload request. Larger batches of spans are sent as several requests. A single span larger than this is sent in a request of its own. |
| `debug` | `TRACEROOT_CODEX_DEBUG` | `false` | Log to stderr. |
| `fail_on_error` | `TRACEROOT_CODEX_FAIL_ON_ERROR` | `false` | Off by default — tracing never blocks a Codex turn. |

</details>

## Headless runs

Non-interactive Codex never shows the trust prompt, so untrusted hooks are skipped silently and no traces are sent. Trust has to be in place before the run. Every route below grants the same thing as the interactive prompt: permission for `dist/index.mjs` to run as your user, outside the sandbox, after each tool call and at the end of each turn. Read `hooks/hooks.json` and the script before you grant it. In order of preference:

1. **Trust interactively, then carry the entries over.** Run `codex` once somewhere you can answer the prompt, trust the hooks, then copy the three `[hooks.state."tracing@traceroot-codex-plugin:…"]` tables Codex wrote to `~/.codex/config.toml` into the config your headless environment uses. The hashes come from your own Codex, so there is nothing to take on faith.

2. **Write the entries yourself.** If you can't run Codex interactively anywhere, these are the entries Codex generates for the `hooks.json` shipped in plugin 0.1.1 (verified on Codex 0.135 through 0.163):

   ```toml
   [hooks.state."tracing@traceroot-codex-plugin:hooks/hooks.json:post_tool_use:0:0"]
   trusted_hash = "sha256:e186b7bd1e81cc36c633fa41eb92565fb99bee4470cea20c9bdf50a1841d7016"

   [hooks.state."tracing@traceroot-codex-plugin:hooks/hooks.json:subagent_stop:0:0"]
   trusted_hash = "sha256:4fbd2c77d57fa709355544c2b1253759b341497b6e0af8d07ff8e0651fee12bb"

   [hooks.state."tracing@traceroot-codex-plugin:hooks/hooks.json:stop:0:0"]
   trusted_hash = "sha256:0342f9f2f04f3c2f99a2098d368a741f90315ded92d73a5d3a6d1198d7ebb100"
   ```

   Know what these are before pasting them. Each hash covers one hook definition (event, command string, timeout, status message) from `hooks/hooks.json`, not the code in `dist/index.mjs`. So they stay valid across plugin updates even though the script changed, and they stop matching if `hooks.json` changes, in which case Codex treats the hooks as untrusted again. To check them, trust the hooks once in an interactive session and compare with what Codex writes to `config.toml`, or read the current `hooks.json` at the tag you installed. If they don't match, don't paste; review the hooks again.

3. **`codex exec --dangerously-bypass-hook-trust`**, as a last resort. This skips the trust check for every hook in that run, not only this plugin's. It's intended for one-off automation that vets hook sources elsewhere, not as the standing flag in a CI job; use 1 or 2 for that.

To check a headless setup, run `codex exec --skip-git-repo-check "echo hello" < /dev/null`. The output should include `hook: Stop Completed`, and a trace should appear in TraceRoot. If there are no `hook:` lines, the hooks aren't trusted. If the hooks run but no trace appears, check `api_key` and `host_url`.

## Privacy

Only what appears in your traces is sent to your TraceRoot host: prompts, tool inputs/outputs (which can include commands and file contents), model and token info, and git repo/branch. If your tools handle secrets, their inputs/outputs are part of the trace.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
