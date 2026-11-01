/**
 * Subagent tracing emission tests.
 * These tests inject findSubagent so they never touch the real ~/.codex.
 */
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeSpanId, makeTraceId } from "../src/ids.js";
import { dispatch } from "../src/emit.js";
import type { Config } from "../src/config.js";
import { memTracing } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "fixtures");

const config: Config = {
  enabled: true, apiKey: "tr-x", hostUrl: "http://x", maxChars: 20000, maxRequestBytes: 12 * 1024 * 1024, debug: false, failOnError: true,
};

let tmpDir: string;
afterEach(async () => { if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }); });

/** Copy a fixture file to a fresh temp dir and return the temp path. */
async function copyFixture(name: string): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-sa-"));
  const dst = path.join(tmpDir, name);
  await fs.copyFile(path.join(fixturesDir, name), dst);
  return dst;
}

/** Build a buildTracing that keeps spans in `mem`. */
function makeTracingDeps(mem: InMemorySpanExporter) {
  return {
    buildTracing: () => memTracing(mem),
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
});
