# traceroot-codex-plugin

Trace OpenAI Codex sessions to [TraceRoot](https://traceroot.ai). Every query becomes **one live trace** — agent turn, model calls, tool calls, file edits, and any subagents it spawns — streamed as the agent works and linked to your git repo. No service to run, and the hooks fail open, so a tracing error doesn't stop Codex.

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

Trust the plugin's hooks. Codex won't run a plugin's hooks until you've reviewed and trusted them, and installing the plugin doesn't do that for you. The reason it asks: hooks run as your user, outside Codex's sandbox. What you're trusting here is three hook definitions in [`plugins/tracing/hooks/hooks.json`](plugins/tracing/hooks/hooks.json) (`PostToolUse`, `Stop`, `SubagentStop`), each running `node "$PLUGIN_ROOT/dist/index.mjs"`. That script reads the session transcript and sends spans to your TraceRoot host; it writes nothing back into Codex and fails open. Hooks of one session take turns through a lock directory next to the transcript (`<transcript>.traceroot.lock.d`). A hook that waits more than 10 s for it leaves a request in `<transcript>.traceroot.pending.d` and exits, and may start a background copy of the same script (`node dist/index.mjs --drain`, holding `<transcript>.traceroot.drainer.d` while it works) that sends the rest and exits within 2 minutes. Source is in [`plugins/tracing/src/`](plugins/tracing/src/).

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

Resolved highest-precedence first: env vars → project `.codex/traceroot.json` → global `~/.codex/traceroot.json` → defaults. `api_key`, `host_url` and `capture_images` are read only from env vars or the global file, so a repository you open can't redirect your uploads or turn on image capture.

| JSON key | Env var | Default | Notes |
|----------|---------|---------|-------|
| `enabled` | `TRACE_TO_TRACEROOT` | `false` | Turn tracing on (an API key must also be set). |
| `api_key` | `TRACEROOT_CODEX_API_KEY` or `TRACEROOT_API_KEY` | — | Required. |
| `host_url` | `TRACEROOT_CODEX_HOST_URL` or `TRACEROOT_HOST_URL` | `https://app.traceroot.ai` | Point at a self-hosted instance. |
| `environment` | `TRACEROOT_ENVIRONMENT` | — | Environment recorded on each trace. |
| `user_id` | `TRACEROOT_CODEX_USER_ID` | — | User ID recorded on each trace. |
| `max_chars` | `TRACEROOT_CODEX_MAX_CHARS` | `20000` | Truncate long span attributes. |
| `max_request_bytes` | `TRACEROOT_CODEX_MAX_REQUEST_BYTES` | `12582912` (12 MiB) | Target for the estimated size of one upload request. Larger batches of spans, or more than 1,024 spans, are sent as several requests. A single span larger than this is sent in a request of its own. |
| `debug` | `TRACEROOT_CODEX_DEBUG` | `false` | Log to stderr. |
| `fail_on_error` | `TRACEROOT_CODEX_FAIL_ON_ERROR` | `false` | Off by default — tracing never blocks a Codex turn. |
| `capture_images` | `TRACEROOT_CODEX_CAPTURE_IMAGES` | `false` | Send screenshots from tool output and images attached to prompts. See [Images](#images). |

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

## Images

By default, tool output is cut at `max_chars`, which also cuts any screenshot in it, and images attached to a prompt are left out of the trace. Set `capture_images` to `true` in `~/.codex/traceroot.json` (or `TRACEROOT_CODEX_CAPTURE_IMAGES=true`) to keep them. A project's `.codex/traceroot.json` can't turn this on, so a repository you open can't start sending your screen content. With it on:

- Tool output keeps PNG, JPEG, GIF and WebP images (`data:image/...;base64,` URLs) whole. `max_chars` applies to the rest of the output.
- Images attached to a prompt, in the same four formats, appear in the first model call's input. An image attached to a message you send while the turn is running appears in the input of the model call that follows it. The turn's input shows `[image: see first model call]` or `[image: see model call <n>]` in their place, where `<n>` is that call's `codex.step_index`, because the turn is sent again on every hook.
- When a tool's output is fed to the next model call, each image in it shows there as `[image: see tool call <call id>]` instead of a second copy. The tool span's metadata carries the matching `call_id`.
- An image larger than 5 MiB is replaced with `[image omitted: larger than 5 MiB]`. If a span would still be larger than 8 MiB, its largest images are replaced with `[image omitted: span larger than 8 MiB]` until it fits. Where a placeholder would point at an image replaced this way, it shows the same text instead.

Screenshots are stored as images only when your TraceRoot server has image extraction enabled for the project. On a self-hosted server, set `ATTACHMENT_ENABLED=true`, and optionally `ATTACHMENT_PROJECT_IDS` to a comma-separated list of the projects to enable it for. Without it, screenshots are stored inline in the span text. See [Images in span input and output](https://traceroot.ai/docs/tracing/data-capture#images-in-span-input-and-output) for the server's own limits and placeholders, and [Self-hosting](https://traceroot.ai/docs/developer/self-hosting#image-attachments) for its settings.

## Sending and retries

Each hook sends what it read in requests of up to `max_request_bytes`, one at a time, and records a span as sent (in `<transcript>.traceroot`) only once TraceRoot accepts the request carrying it. A request answered with 429, 502, 503 or 504 is retried a few times within the export's 10 s timeout, following `Retry-After`. Spans that still aren't accepted are sent by the session's next hook, after the next tool call or turn end.

A hook that hands its run to the lock holder starts the background drainer described in [Install](#install), as does a holder that exits with handed-off runs still waiting, because a run failed or it used its 15 s budget. Only one drainer runs per session. It retries a failed run after 1 s, 2 s, 4 s and so on, up to 15 s apart, starts no run after 90 s, and exits within 2 minutes; anything left is sent by the session's next hook. Set `debug` to see these steps on stderr.

## Privacy

Only what appears in your traces is sent to your TraceRoot host: prompts, tool inputs/outputs (which can include commands and file contents), model and token info, and git repo/branch. If your tools handle secrets, their inputs/outputs are part of the trace. With `capture_images` on, screenshots and other images in tool output, and images you attach to prompts, are sent too.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
