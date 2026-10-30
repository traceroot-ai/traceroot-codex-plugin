import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { type ReadableSpan, type SpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Config, getConfig } from "../src/config.js";
import { dispatch } from "../src/emit.js";
import { buildTracing, buildTracingWith, DeliveryTrackingExporter, SizeLimitedExporter } from "../src/exporter.js";
import { makeSpanId, PrimedIdGenerator } from "../src/ids.js";
import { loadEmittedSpanIds } from "../src/sidecar.js";
import { estimateSpanBytes } from "../src/size.js";
import { failed, ids, OK, ScriptedExporter } from "./helpers.js";

const MiB = 1024 * 1024;
const BUDGET = 12 * MiB;

/** `count` real ReadableSpans, each carrying `bytes` of output text. */
async function makeSpans(count: number, bytes: number): Promise<ReadableSpan[]> {
  const sink = new ScriptedExporter();
  const tracing = buildTracingWith(new SimpleSpanProcessor(sink), new PrimedIdGenerator());
  for (let i = 0; i < count; i++) {
    tracing.tracer.startSpan(`span-${i}`, { attributes: { "traceroot.span.output": "x".repeat(bytes) } }).end();
  }
  await tracing.shutdown();
  return sink.calls.flat();
}

function exportOnce(exporter: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> {
  return new Promise((resolve) => exporter.export(spans, resolve));
}

const sizeOf = (spans: ReadableSpan[]): number => spans.reduce((n, s) => n + estimateSpanBytes(s), 0);

describe("SizeLimitedExporter", () => {
  it("sends 1,024 small spans as one request", async () => {
    const spans = await makeSpans(1024, 100);
    const inner = new ScriptedExporter();
    expect(await exportOnce(new SizeLimitedExporter(inner, BUDGET), spans)).toEqual(OK);
    expect(inner.calls).toEqual([spans]);
  });

  it("sends spans totalling 30 MiB as three or more requests, each under the budget", async () => {
    const spans = await makeSpans(30, MiB);
    const inner = new ScriptedExporter();
    expect(await exportOnce(new SizeLimitedExporter(inner, BUDGET), spans)).toEqual(OK);
    expect(inner.calls.length).toBeGreaterThanOrEqual(3);
    for (const request of inner.calls) expect(sizeOf(request)).toBeLessThanOrEqual(BUDGET);
    expect(inner.calls.flat()).toEqual(spans);
  });

  it("sends the requests one at a time", async () => {
    const spans = await makeSpans(3, MiB);
    let inFlight = 0;
    let maxInFlight = 0;
    const inner: SpanExporter = {
      export: (_spans, resultCallback) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        setTimeout(() => { inFlight--; resultCallback(OK); }, 1);
      },
      shutdown: async () => {},
    };
    await exportOnce(new SizeLimitedExporter(inner, MiB + 1024), spans);
    expect(maxInFlight).toBe(1);
  });

  it("sends a span larger than the budget on its own", async () => {
    const [small, huge] = [await makeSpans(1, 10), await makeSpans(1, 2 * MiB)];
    const inner = new ScriptedExporter();
    await exportOnce(new SizeLimitedExporter(inner, MiB), [...small, ...huge, ...small]);
    expect(inner.calls).toEqual([small, huge, small]);
  });

  it("fails only the spans of the request that failed, and still sends the rest", async () => {
    const spans = await makeSpans(30, MiB);
    let call = 0;
    const inner = new ScriptedExporter(() => (++call === 2 ? failed("Request Entity Too Large") : OK));
    const tracked = new DeliveryTrackingExporter(inner);

    const result = await exportOnce(new SizeLimitedExporter(tracked, BUDGET), spans);

    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error?.message).toBe("Request Entity Too Large");
    expect(inner.calls.length).toBeGreaterThanOrEqual(3);
    const failedIds = ids(inner.calls[1]!);
    expect([...tracked.delivered].sort()).toEqual(ids(spans).filter((id) => !failedIds.includes(id)).sort());
  });

  it("reports the first failure when several requests fail", async () => {
    const spans = await makeSpans(3, MiB);
    let call = 0;
    const inner = new ScriptedExporter(() => (++call === 1 ? "throw" : failed("Service Unavailable")));
    const result = await exportOnce(new SizeLimitedExporter(inner, MiB + 1024), spans);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error?.message).toBe("exporter crashed");
    expect(inner.calls).toHaveLength(3);
  });

  it("succeeds without a request when there are no spans", async () => {
    const inner = new ScriptedExporter();
    expect(await exportOnce(new SizeLimitedExporter(inner, BUDGET), [])).toEqual(OK);
    expect(inner.calls).toHaveLength(0);
  });

  it.each(["shutdown", "forceFlush"] as const)("%s waits for the requests of an export in flight", async (method) => {
    const spans = await makeSpans(3, MiB);
    const order: string[] = [];
    const inner: SpanExporter = {
      export: (_spans, resultCallback) => { order.push("export"); setTimeout(() => resultCallback(OK), 1); },
      shutdown: async () => { order.push("shutdown"); },
      forceFlush: async () => { order.push("forceFlush"); },
    };
    const limited = new SizeLimitedExporter(inner, MiB + 1024);
    let result: ExportResult | undefined;
    limited.export(spans, (r) => { result = r; });

    await limited[method]();
    expect(order).toEqual(["export", "export", "export", method]);
    expect(result).toEqual(OK);
  });

  it("forwards shutdown and forceFlush to the wrapped exporter", async () => {
    const inner = { export: vi.fn(), shutdown: vi.fn(async () => {}), forceFlush: vi.fn(async () => {}) };
    const limited = new SizeLimitedExporter(inner, BUDGET);
    await limited.forceFlush();
    await limited.shutdown();
    expect(inner.forceFlush).toHaveBeenCalledTimes(1);
    expect(inner.shutdown).toHaveBeenCalledTimes(1);
    await expect(new SizeLimitedExporter({ export: vi.fn(), shutdown: async () => {} }, BUDGET).forceFlush())
      .resolves.toBeUndefined();
  });
});

const config: Config = {
  enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 20000, maxRequestBytes: BUDGET,
  debug: false, failOnError: true,
};

describe("buildTracing splits each flush by max_request_bytes", () => {
  function endSpans(tracing: ReturnType<typeof buildTracing>, count: number, bytes: number): void {
    for (let i = 0; i < count; i++) {
      tracing.tracer.startSpan(`span-${i}`, { attributes: { "traceroot.span.output": "x".repeat(bytes) } }).end();
    }
  }

  it("sends requests under the configured budget and counts every span delivered", async () => {
    const inner = new ScriptedExporter();
    const tracing = buildTracing({ ...config, maxRequestBytes: 3 * MiB }, inner);
    endSpans(tracing, 6, MiB);
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
    endSpans(tracing, 6, MiB);
    await expect(tracing.shutdown()).rejects.toBeDefined();

    const lost = ids(inner.calls[0]!);
    expect(lost.length).toBeGreaterThan(0);
    expect([...tracing.delivered].sort()).toEqual(ids(inner.calls.flat()).filter((id) => !lost.includes(id)).sort());
  });
});

it("buildTracing delivers a first full batch split across requests before shutdown returns", async () => {
  // The processor exports a full 1,024-span batch as soon as it fills, outside
  // the final flush, so shutdown must wait for all of that batch's requests.
  let stopped = false;
  const late: string[] = [];
  const inner = new ScriptedExporter((spans) => {
    if (stopped) late.push(...ids(spans));
    return OK;
  });
  inner.shutdown = async () => { stopped = true; };
  const tracing = buildTracing({ ...config, maxRequestBytes: 64 * 1024 }, inner);
  for (let i = 0; i < 1100; i++) {
    tracing.tracer.startSpan(`span-${i}`, { attributes: { "traceroot.span.output": "x".repeat(1000) } }).end();
  }
  await tracing.shutdown();

  expect(late).toEqual([]);
  expect(inner.calls.length).toBeGreaterThan(2);
  expect(tracing.delivered.size).toBe(1100);
});

describe("dispatch with a request that fails", () => {
  let dir: string;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("re-sends only the spans of that request on the next hook", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-split-"));
    const transcript = path.join(dir, "rollout.jsonl");
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
    fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n"));

    // Each 1 MiB tool span needs a request of its own under a 1.5 MiB budget.
    const big2 = { ...config, maxChars: 2 * MiB, maxRequestBytes: 1.5 * MiB };
    const toolB = makeSpanId("b");
    const exporter = new ScriptedExporter((spans) => (ids(spans).includes(toolB) ? failed("Request Entity Too Large") : OK));
    const deps = (e: ScriptedExporter) => ({ buildTracing: (c: Config) => buildTracing(c, e), getGit: async () => ({}) });

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

describe("max_request_bytes setting", () => {
  const saved = { ...process.env };
  let home: string;
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("TRACE")) delete process.env[k];
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tr-codexhome-"));
    process.env.CODEX_HOME = home;
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("defaults to 12 MiB", async () => {
    expect((await getConfig()).maxRequestBytes).toBe(12 * MiB);
  });

  it("reads TRACEROOT_CODEX_MAX_REQUEST_BYTES", async () => {
    process.env.TRACEROOT_CODEX_MAX_REQUEST_BYTES = "5000000";
    expect((await getConfig()).maxRequestBytes).toBe(5_000_000);
  });

  it("reads max_request_bytes from traceroot.json", async () => {
    fs.writeFileSync(path.join(home, "traceroot.json"), JSON.stringify({ max_request_bytes: 4194304 }));
    expect((await getConfig()).maxRequestBytes).toBe(4 * MiB);
  });

  it.each(["0", "-1", "lots"])("falls back to the default for %j", async (value) => {
    process.env.TRACEROOT_CODEX_MAX_REQUEST_BYTES = value;
    expect((await getConfig()).maxRequestBytes).toBe(12 * MiB);
  });
});
