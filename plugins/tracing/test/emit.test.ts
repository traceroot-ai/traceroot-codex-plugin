import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "../src/emit.js";
import type { Config } from "../src/config.js";
import { memTracing } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const config: Config = {
  enabled: true, apiKey: "tr-x", hostUrl: "http://x", maxChars: 20000, maxRequestBytes: 12 * 1024 * 1024, debug: false, failOnError: true,
};

let dir: string;
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

async function copyFixture(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-emit-"));
  const dst = path.join(dir, "rollout.jsonl");
  await fs.copyFile(path.join(here, "fixtures", "rollout-basic.jsonl"), dst);
  return dst;
}

describe("dispatch", () => {
  it("emits AGENT+LLM+TOOL once, and is idempotent on a second run", async () => {
    const transcript = await copyFixture();
    const mem = new InMemorySpanExporter();
    const deps = {
      buildTracing: () => memTracing(mem),
      getGit: async () => ({ repo: "traceroot-ai/traceroot", ref: "a".repeat(40) }),
    };

    const r1 = await dispatch({ transcript_path: transcript }, config, deps);
    expect(r1.emitted).toBe(3);
    expect(mem.getFinishedSpans()).toHaveLength(3);

    const r2 = await dispatch({ transcript_path: transcript }, config, deps);
    // The trace root re-emits every dispatch (so the trace stays named "Codex
    // Turn" with a refreshed end/output); the LLM+TOOL spans dedup via sidecar.
    expect(r2.emitted).toBe(1);
  });

  it("live: completed LLM/TOOL stream mid-turn with NO root (trace stays live); Stop emits the root", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-live-"));
    const transcript = path.join(dir, "rollout.jsonl");
    await fs.copyFile(path.join(here, "fixtures", "rollout-inprogress.jsonl"), transcript);

    const mem = new InMemorySpanExporter();
    // memTracing's shutdown only flushes, so the InMemory exporter keeps spans
    // across dispatch() calls.
    const deps = {
      buildTracing: () => memTracing(mem),
      getGit: async () => ({}),
    };

    // Mid-turn PostToolUse hook: the already-complete LLM step + its TOOL emit,
    // but the root does NOT — so ClickHouse holds no completed root and the
    // backend keeps the live SSE stream open (the trace updates without refresh).
    const r1 = await dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, config, deps);
    expect(r1.emitted).toBe(2);
    expect(mem.getFinishedSpans().map((s) => s.attributes["traceroot.span.type"]).sort())
      .toEqual(["LLM", "TOOL"]);

    // The terminal Stop hook ends the turn: the root emits (even though this
    // in-progress rollout never got a task_complete), which signals trace_complete.
    const r2 = await dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config, deps);
    expect(r2.emitted).toBe(1);
    expect(mem.getFinishedSpans().filter((s) => s.attributes["traceroot.span.type"] === "AGENT")).toHaveLength(1);
  });

  it("skips standalone emission for a subagent session (it nests under its parent)", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-sub-"));
    const transcript = path.join(dir, "rollout.jsonl");
    // A subagent session: session_meta marks thread_source=subagent + parent_thread_id.
    const lines = [
      '{"timestamp":"2026-06-30T00:00:00.000Z","type":"session_meta","payload":{"id":"child-1","thread_source":"subagent","parent_thread_id":"parent-1"}}',
      '{"timestamp":"2026-06-30T00:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"ct1"}}',
      '{"timestamp":"2026-06-30T00:00:02.000Z","type":"turn_context","payload":{"turn_id":"ct1","model":"gpt-5.5"}}',
      '{"timestamp":"2026-06-30T00:00:03.000Z","type":"response_item","payload":{"type":"function_call","call_id":"x1","name":"exec_command","arguments":"{}"}}',
      '{"timestamp":"2026-06-30T00:00:04.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"x1","output":"ok"}}',
      '{"timestamp":"2026-06-30T00:00:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":1}}}}',
      '{"timestamp":"2026-06-30T00:00:06.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"ct1"}}',
    ].join("\n");
    await fs.writeFile(transcript, lines);
    const mem = new InMemorySpanExporter();
    const deps = {
      buildTracing: () => memTracing(mem),
      getGit: async () => ({}),
    };
    const r = await dispatch({ transcript_path: transcript }, config, deps);
    expect(r.emitted).toBe(0); // suppressed — parent owns the nesting
    expect(mem.getFinishedSpans()).toHaveLength(0);
  });
});
