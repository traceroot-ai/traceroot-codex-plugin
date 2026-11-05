/**
 * Subagent tracing emission tests.
 * These tests inject findSubagent so they never touch the real ~/.codex.
 */
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeSpanId, makeTraceId } from "../src/ids.js";
import { dispatch } from "../src/emit.js";
import { copyFixture, memExporter, testConfig, writeRollout } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

const config = testConfig();

/** Deps whose exporter keeps spans in `mem`. */
function makeTracingDeps(mem: InMemorySpanExporter) {
  return {
    exporter: () => memExporter(mem),
    getGit: async () => ({}),
  };
}

// ---- helpers to derive expected span ids ----
const parentTraceId = makeTraceId("parent-sess", "parent-turn-1");
const parentRootId = makeSpanId("parent-turn-1:root");
const parentStepId = makeSpanId("parent-turn-1:step:0");
const spawnToolId  = makeSpanId("spawn-1");           // seed="" + callId="spawn-1"

const childSeed    = "child-thread-1:";
const childRootId  = makeSpanId(childSeed + "child-turn-1:root");
const childStepId  = makeSpanId(childSeed + "child-turn-1:step:0");
const childExecId  = makeSpanId(childSeed + "child-exec-1");

// Codex 0.166: spawn_agent returns {task_name}; the child thread id is in sub_agent_activity.
const ev = (t: string, payload: object) => ({ timestamp: `2026-11-01T00:00:${t}Z`, type: "event_msg", payload });
const ri = (t: string, payload: object) => ({ timestamp: `2026-11-01T00:00:${t}Z`, type: "response_item", payload });
const parentMeta = { timestamp: "2026-11-01T00:00:00Z", type: "session_meta", payload: { id: "p166", thread_source: "user" } };
const parentTurnLines = (t: string) => [
  ev(t, { type: "task_started", turn_id: "p-turn" }),
  ri(t, { type: "function_call", name: "exec_command", call_id: "p-exec", arguments: "{}" }),
  ri(t, { type: "function_call_output", call_id: "p-exec", output: "start" }),
  ri(t, { type: "function_call", name: "spawn_agent", call_id: "spawn-166", arguments: "{\"task_name\":\"echo_one\"}" }),
];
const parent166 = [
  parentMeta,
  ...parentTurnLines("01"),
  ev("02", { type: "sub_agent_activity", event_id: "spawn-166", agent_thread_id: "c166", agent_path: "/root/echo_one", kind: "started" }),
  ri("02", { type: "function_call_output", call_id: "spawn-166", output: "{\"task_name\":\"/root/echo_one\"}" }),
  ri("05", { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }),
  ev("05", { type: "token_count", info: { last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  ev("06", { type: "task_complete", turn_id: "p-turn" }),
];
// A forked child: its session_meta, a copy of the parent's (meta included), then its own turn.
const child166 = [
  { timestamp: "2026-11-01T00:00:02Z", type: "session_meta",
    payload: { id: "c166", thread_source: "subagent", parent_thread_id: "p166", forked_from_id: "p166" } },
  { ...parentMeta, timestamp: "2026-11-01T00:00:02Z" },
  ...parentTurnLines("02"),
  ev("02", { type: "turn_aborted", turn_id: "p-turn", reason: "interrupted" }),
  ev("03", { type: "task_started", turn_id: "c-turn" }),
  ri("03", { type: "function_call", name: "exec_command", call_id: "c-exec", arguments: "{}" }),
  ri("04", { type: "function_call_output", call_id: "c-exec", output: "hi" }),
  ri("04", { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }),
  ev("04", { type: "token_count", info: { last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  ev("04", { type: "task_complete", turn_id: "c-turn" }),
];

describe("dispatch with subagent", () => {
  it("1. emits spans from both parent and child, all sharing one traceId", async () => {
    const transcript = await copyFixture("rollout-with-subagent.jsonl");
    const childPath  = path.join(fixturesDir, "rollout-child-thread-1.jsonl");
    const mem = new InMemorySpanExporter();

    const r = await dispatch({ transcript_path: transcript }, config, {
      ...makeTracingDeps(mem),
      findSubagent: async (id) => id === "child-thread-1" ? childPath : undefined,
    });

    // 3 parent + 3 child = 6 spans total
    expect(r.emitted).toBe(6);
    const spans = mem.getFinishedSpans();
    expect(spans).toHaveLength(6);

    // All spans share the parent traceId
    const allTraceIds = spans.map((s) => s.spanContext().traceId);
    expect(allTraceIds.every((id) => id === parentTraceId)).toBe(true);
  });

  it("2. child root AGENT span is nested under the parent spawn TOOL span", async () => {
    const transcript = await copyFixture("rollout-with-subagent.jsonl");
    const childPath  = path.join(fixturesDir, "rollout-child-thread-1.jsonl");
    const mem = new InMemorySpanExporter();

    await dispatch({ transcript_path: transcript }, config, {
      ...makeTracingDeps(mem),
      findSubagent: async (id) => id === "child-thread-1" ? childPath : undefined,
    });

    const spans = mem.getFinishedSpans();
    const childRoot = spans.find((s) => s.spanContext().spanId === childRootId);
    expect(childRoot).toBeDefined();
    // parentSpanId of the child root = the spawn TOOL span id
    expect(childRoot!.parentSpanContext?.spanId).toBe(spawnToolId);
  });

  it("3. child tool span (exec_command) exists in the same trace", async () => {
    const transcript = await copyFixture("rollout-with-subagent.jsonl");
    const childPath  = path.join(fixturesDir, "rollout-child-thread-1.jsonl");
    const mem = new InMemorySpanExporter();

    await dispatch({ transcript_path: transcript }, config, {
      ...makeTracingDeps(mem),
      findSubagent: async (id) => id === "child-thread-1" ? childPath : undefined,
    });

    const spans = mem.getFinishedSpans();
    const childExec = spans.find((s) => s.spanContext().spanId === childExecId);
    expect(childExec).toBeDefined();
    expect(childExec!.name).toBe("exec_command");
    expect(childExec!.spanContext().traceId).toBe(parentTraceId);
  });

  it("4. idempotency: second dispatch re-emits only the trace root", async () => {
    const transcript = await copyFixture("rollout-with-subagent.jsonl");
    const childPath  = path.join(fixturesDir, "rollout-child-thread-1.jsonl");
    const mem = new InMemorySpanExporter();
    const deps = {
      ...makeTracingDeps(mem),
      findSubagent: async (id: string) => id === "child-thread-1" ? childPath : undefined,
    };

    const r1 = await dispatch({ transcript_path: transcript }, config, deps);
    expect(r1.emitted).toBe(6);

    const r2 = await dispatch({ transcript_path: transcript }, config, deps);
    // Only the trace root re-emits (for live naming/refresh); every other span —
    // including all subagent spans — dedups via the sidecar.
    expect(r2.emitted).toBe(1);
  });

  it("5. cycle guard: child that re-spawns an already-visited thread terminates without duplicates", async () => {
    // rollout-with-subagent spawns "child-thread-1"
    // rollout-child-spawner (used for child-thread-1) itself spawns "child-thread-1" back → cycle
    const transcript  = await copyFixture("rollout-with-subagent.jsonl");
    const spawnerPath = path.join(fixturesDir, "rollout-child-spawner.jsonl");
    const mem = new InMemorySpanExporter();

    // findSubagent returns the spawner child for any id — so the self-reference
    // from child-spawner also resolves, but visited-set prevents re-entering.
    const calls: string[] = [];
    const r = await dispatch({ transcript_path: transcript }, config, {
      ...makeTracingDeps(mem),
      findSubagent: async (id) => { calls.push(id); return spawnerPath; },
    });

    // Dispatch must complete (not loop)
    expect(r.emitted).toBeGreaterThan(0);

    // "child-thread-1" must only be requested once (visited-set skips the second occurrence)
    const childCalls = calls.filter((id) => id === "child-thread-1");
    expect(childCalls).toHaveLength(1);

    // Each span id must appear exactly once in the emitted set
    const spanIds = mem.getFinishedSpans().map((s) => s.spanContext().spanId);
    const uniqueIds = new Set(spanIds);
    expect(spanIds).toHaveLength(uniqueIds.size);
  });

  it("6. fail-soft: a throwing findSubagent does not propagate; parent spans still emit", async () => {
    const transcript = await copyFixture("rollout-with-subagent.jsonl");
    const mem = new InMemorySpanExporter();

    // Resolver throws — dispatch must NOT propagate; parent spans must still flush.
    const r = await dispatch({ transcript_path: transcript }, config, {
      ...makeTracingDeps(mem),
      findSubagent: async () => { throw new Error("resolver boom"); },
    });

    // Only the 3 parent spans emitted (child resolution failed fail-soft).
    expect(r.emitted).toBe(3);
    const spans = mem.getFinishedSpans();
    const ids = spans.map((s) => s.spanContext().spanId);
    expect(ids).toContain(parentRootId);
    expect(ids).toContain(parentStepId);
    expect(ids).toContain(spawnToolId);
    // No child spans were emitted.
    expect(ids).not.toContain(childRootId);
  });

  it("7. Codex 0.166: sub_agent_activity nests the child under spawn_agent, without its copied parent turn", async () => {
    const transcript = await writeRollout(parent166);
    const childPath = await writeRollout(child166);
    const mem = new InMemorySpanExporter();

    await dispatch({ transcript_path: transcript }, config, {
      ...makeTracingDeps(mem),
      findSubagent: async (id) => id === "c166" ? childPath : undefined,
    });

    const spans = mem.getFinishedSpans();
    const childRoot = spans.find((s) => s.spanContext().spanId === makeSpanId("c166:c-turn:root"));
    expect(childRoot?.parentSpanContext?.spanId).toBe(makeSpanId("spawn-166"));
    expect(childRoot?.spanContext().traceId).toBe(makeTraceId("p166", "p-turn"));
    const ids = spans.map((s) => s.spanContext().spanId);
    expect(ids).toContain(makeSpanId("c166:c-exec"));
    // The copied parent turn is emitted once, by the parent, not again under the child's seed.
    expect(ids).not.toContain(makeSpanId("c166:p-exec"));
    expect(ids).not.toContain(makeSpanId("c166:p-turn:root"));
    expect(ids.filter((id) => id === makeSpanId("p-exec"))).toHaveLength(1);
  });

  it("8. a child rollout holding a copy of the parent's session_meta emits nothing standalone", async () => {
    const childPath = await writeRollout(child166);
    const mem = new InMemorySpanExporter();

    const r = await dispatch({ transcript_path: childPath, hook_event_name: "PostToolUse" }, config, {
      ...makeTracingDeps(mem),
      findSubagent: async () => undefined,
    });

    expect(r.emitted).toBe(0);
    expect(mem.getFinishedSpans()).toHaveLength(0);
  });
});
