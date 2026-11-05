import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { dispatch } from "../src/emit.js";
import { buildTracing, sendInRequests } from "../src/exporter.js";
import { makeSpanId } from "../src/ids.js";
import { loadEmittedSpanIds } from "../src/sidecar.js";
import { estimateSpanBytes } from "../src/size.js";
import {
  distinctIds, endSpans, failed, ids, makeSpans, OK, ScriptedExporter, testConfig, writeRollout,
} from "./helpers.js";

const MiB = 1024 * 1024;
const BUDGET = 12 * MiB;

const sizeOf = (spans: ReadableSpan[]): number => spans.reduce((n, s) => n + estimateSpanBytes(s), 0);

describe("sendInRequests splits by size", () => {
  it("sends 1,024 small spans as one request", async () => {
    const spans = await makeSpans(distinctIds(1024), 100);
    const inner = new ScriptedExporter();
    await sendInRequests(inner, spans, BUDGET, new Set());
    expect(inner.calls).toEqual([spans]);
  });

  it("sends spans totalling 30 MiB as three or more requests, each under the budget", async () => {
    const spans = await makeSpans(distinctIds(30), MiB);
    const inner = new ScriptedExporter();
    await sendInRequests(inner, spans, BUDGET, new Set());
    expect(inner.calls.length).toBeGreaterThanOrEqual(3);
    for (const request of inner.calls) expect(sizeOf(request)).toBeLessThanOrEqual(BUDGET);
    expect(inner.calls.flat()).toEqual(spans);
  });

  it("sends a span larger than the budget on its own", async () => {
    const [small, huge] = [await makeSpans(["1".repeat(16)], 10), await makeSpans(["2".repeat(16)], 2 * MiB)];
    const inner = new ScriptedExporter();
    await sendInRequests(inner, [...small, ...huge, ...small], MiB, new Set());
    expect(inner.calls).toEqual([small, huge, small]);
  });

  it("fails only the spans of the request that failed, and still sends the rest", async () => {
    const spans = await makeSpans(distinctIds(30), MiB);
    let call = 0;
    const inner = new ScriptedExporter(() => (++call === 2 ? failed("Request Entity Too Large") : OK));
    const delivered = new Set<string>();

    await expect(sendInRequests(inner, spans, BUDGET, delivered)).rejects.toThrow("Request Entity Too Large");

    expect(inner.calls.length).toBeGreaterThanOrEqual(3);
    const failedIds = ids(inner.calls[1]!);
    expect([...delivered].sort()).toEqual(ids(spans).filter((id) => !failedIds.includes(id)).sort());
  });

  it("reports the first failure when several requests fail", async () => {
    const spans = await makeSpans(distinctIds(3), MiB);
    let call = 0;
    const inner = new ScriptedExporter(() => (++call === 1 ? "throw" : failed("Service Unavailable")));
    await expect(sendInRequests(inner, spans, MiB + 1024, new Set())).rejects.toThrow("exporter crashed");
    expect(inner.calls).toHaveLength(3);
  });

  it("succeeds without a request when there are no spans", async () => {
    const inner = new ScriptedExporter();
    await sendInRequests(inner, [], BUDGET, new Set());
    expect(inner.calls).toHaveLength(0);
  });
});

const config = testConfig({ maxRequestBytes: BUDGET });

describe("buildTracing splits its spans by max_request_bytes", () => {
  it("sends requests under the configured budget and counts every span delivered", async () => {
    const inner = new ScriptedExporter();
    const tracing = buildTracing({ ...config, maxRequestBytes: 3 * MiB }, inner);
    endSpans(tracing, distinctIds(6), MiB);
    await tracing.shutdown();

    expect(inner.calls.length).toBeGreaterThanOrEqual(3);
    for (const request of inner.calls) expect(sizeOf(request)).toBeLessThanOrEqual(3 * MiB);
    expect([...tracing.delivered].sort()).toEqual(ids(inner.calls.flat()).sort());
    expect(tracing.delivered.size).toBe(6);
  });

  it("leaves only the spans of a failed request undelivered", async () => {
    let call = 0;
    const inner = new ScriptedExporter(() => (++call === 1 ? failed("Request Entity Too Large") : OK));
    const tracing = buildTracing({ ...config, maxRequestBytes: 3 * MiB }, inner);
    endSpans(tracing, distinctIds(6), MiB);
    await expect(tracing.shutdown()).rejects.toBeDefined();

    const lost = ids(inner.calls[0]!);
    expect(lost.length).toBeGreaterThan(0);
    expect([...tracing.delivered].sort()).toEqual(ids(inner.calls.flat()).filter((id) => !lost.includes(id)).sort());
  });

  it("sends every request before it shuts the exporter down", async () => {
    let stopped = false;
    const late: string[] = [];
    const inner = new ScriptedExporter((spans) => {
      if (stopped) late.push(...ids(spans));
      return OK;
    });
    inner.shutdown = async () => { stopped = true; };
    const tracing = buildTracing({ ...config, maxRequestBytes: 64 * 1024 }, inner);
    endSpans(tracing, distinctIds(1100), 1000);
    await tracing.shutdown();

    expect(late).toEqual([]);
    expect(inner.calls.length).toBeGreaterThan(2);
    expect(tracing.delivered.size).toBe(1100);
  });
});

const deps = (exporter: ScriptedExporter) => ({
  buildTracing: (c: Config) => buildTracing(c, exporter), getGit: async () => ({}),
});

describe("dispatch with a request that fails", () => {
  it("re-sends only the spans of that request on the next hook", async () => {
    const big = "o".repeat(MiB);
    const at = (s: number) => `2026-06-30T00:00:${String(s).padStart(2, "0")}.000Z`;
    const lines: unknown[] = [
      { timestamp: at(0), type: "session_meta", payload: { id: "sess-split" } },
      { timestamp: at(1), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { timestamp: at(2), type: "event_msg", payload: { type: "user_message", message: "read three big files" } },
    ];
    for (const id of ["a", "b", "c"]) {
      lines.push({ timestamp: at(3), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: "{}" } });
      lines.push({ timestamp: at(4), type: "response_item", payload: { type: "function_call_output", call_id: id, output: big } });
    }
    lines.push(
      { timestamp: at(5), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1 } } } },
      { timestamp: at(6), type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "done" } },
    );
    const transcript = await writeRollout(lines);

    // Each 1 MiB tool span needs a request of its own under a 1.5 MiB budget.
    const big2 = { ...config, maxChars: 2 * MiB, maxRequestBytes: 1.5 * MiB };
    const toolB = makeSpanId("b");
    const exporter = new ScriptedExporter((spans) => (ids(spans).includes(toolB) ? failed("Request Entity Too Large") : OK));

    await expect(dispatch({ transcript_path: transcript }, big2, deps(exporter))).rejects.toBeDefined();
    expect(exporter.calls.length).toBeGreaterThanOrEqual(3);
    const marked = await loadEmittedSpanIds(transcript);
    expect(marked.size).toBe(4);
    expect(marked.has(toolB)).toBe(false);

    const retry = new ScriptedExporter();
    await dispatch({ transcript_path: transcript }, big2, deps(retry));
    expect(ids(retry.calls.flat()).sort()).toEqual([makeSpanId("t1:root"), toolB].sort());
  });
});

describe("dispatch with a tool call whose rollout entry has a missing or non-string name", () => {
  it.each([["missing", {}], ["a number", { name: 42 }]])("sends every span when the name is %s", async (_label, name) => {
    const at = (s: number) => `2026-06-30T00:00:0${s}.000Z`;
    const transcript = await writeRollout([
      { timestamp: at(0), type: "session_meta", payload: { id: "sess-name" } },
      { timestamp: at(1), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { timestamp: at(2), type: "event_msg", payload: { type: "user_message", message: "run it" } },
      { timestamp: at(3), type: "response_item", payload: { type: "function_call", ...name, call_id: "c1", arguments: "{}" } },
      { timestamp: at(4), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "ok" } },
      { timestamp: at(5), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1 } } } },
      { timestamp: at(6), type: "event_msg", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "done" } },
    ]);

    const exporter = new ScriptedExporter();
    await dispatch({ transcript_path: transcript }, config, deps(exporter));
    expect(exporter.calls.flat()).toHaveLength(3);
    expect(await loadEmittedSpanIds(transcript)).toEqual(new Set(ids(exporter.calls.flat())));
  });
});
