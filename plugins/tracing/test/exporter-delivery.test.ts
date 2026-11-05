import { ExportResultCode } from "@opentelemetry/core";
import { type ReadableSpan, type SpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { buildTracing, buildTracingWith, exportOnce, sendInRequests } from "../src/exporter.js";
import { PrimedIdGenerator } from "../src/ids.js";
import { distinctIds, endSpans, failed, ids, makeSpans, OK, ScriptedExporter, testConfig } from "./helpers.js";

const config = testConfig({ failOnError: false });
const BUDGET = config.maxRequestBytes;

describe("exportOnce", () => {
  it("reports a throwing exporter as a failed export instead of throwing", async () => {
    const spans = await makeSpans(["4".repeat(16)]);
    const result = await exportOnce(new ScriptedExporter(() => "throw"), spans);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error?.message).toBe("exporter crashed");
  });

  it("wraps a non-Error throw in an Error", async () => {
    const inner: SpanExporter = {
      export: () => { throw "boom"; },
      shutdown: async () => {},
    };
    const result = await exportOnce(inner, []);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("boom");
  });
});

describe("sendInRequests", () => {
  it("records the ids of an accepted request", async () => {
    const spans = await makeSpans(["1".repeat(16), "2".repeat(16)]);
    const inner = new ScriptedExporter();
    const delivered = new Set<string>();
    await sendInRequests(inner, spans, BUDGET, delivered);
    expect(inner.calls).toEqual([spans]);
    expect([...delivered].sort()).toEqual(["1".repeat(16), "2".repeat(16)]);
  });

  it("rejects and records nothing for a failed request (e.g. a 413 or 503 from the backend)", async () => {
    const spans = await makeSpans(["3".repeat(16)]);
    const delivered = new Set<string>();
    await expect(sendInRequests(new ScriptedExporter(() => failed("Request Entity Too Large")), spans, BUDGET, delivered))
      .rejects.toThrow("Request Entity Too Large");
    expect(delivered.size).toBe(0);
  });

  it("tries every request, one at a time, then rejects with the first failure", async () => {
    const spans = await makeSpans(distinctIds(2049));
    const outcomes = [failed("Request Entity Too Large"), OK, failed("Service Unavailable")];
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: ReadableSpan[][] = [];
    const inner: SpanExporter = {
      export: (request, resultCallback) => {
        const outcome = outcomes[calls.push(request) - 1]!;
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        setTimeout(() => { inFlight--; resultCallback(outcome); }, 1);
      },
      shutdown: async () => {},
    };
    const delivered = new Set<string>();

    await expect(sendInRequests(inner, spans, BUDGET, delivered)).rejects.toThrow("Request Entity Too Large");
    expect(calls.map((c) => c.length)).toEqual([1024, 1024, 1]);
    expect(maxInFlight).toBe(1);
    expect([...delivered].sort()).toEqual(ids(calls[1]!).sort());
  });
});

describe("buildTracing delivery tracking", () => {
  it("exposes the ids the exporter accepted once shutdown resolves", async () => {
    const sink = new ScriptedExporter();
    const tracing = buildTracing(config, sink);
    endSpans(tracing, ["a".repeat(16), "b".repeat(16)]);
    await tracing.shutdown();
    expect(ids(sink.calls.flat()).sort()).toEqual(["a".repeat(16), "b".repeat(16)]);
    expect([...tracing.delivered].sort()).toEqual(["a".repeat(16), "b".repeat(16)]);
  });

  it("shutdown rejects and nothing counts as delivered when the export fails", async () => {
    const tracing = buildTracing(config, new ScriptedExporter(() => failed("Service Unavailable")));
    endSpans(tracing, ["c".repeat(16)]);
    await expect(tracing.shutdown()).rejects.toBeDefined();
    expect(tracing.delivered.size).toBe(0);
  });

  it("sends nothing before shutdown, then every span in requests of at most 1,024", async () => {
    const sink = new ScriptedExporter();
    const tracing = buildTracing(config, sink);
    const sent = distinctIds(2049);
    endSpans(tracing, sent);
    expect(sink.calls).toHaveLength(0);

    await tracing.shutdown();
    expect(sink.calls.map((c) => c.length)).toEqual([1024, 1024, 1]);
    expect(ids(sink.calls.flat())).toEqual(sent);
    expect(tracing.delivered.size).toBe(2049);
  });

  it.each([["succeeds", OK], ["fails", failed("Service Unavailable")]])(
    "shuts the exporter down after the last request, when it %s",
    async (_label, outcome) => {
      const order: string[] = [];
      const inner: SpanExporter = {
        export: (_spans, resultCallback) => { order.push("export"); setTimeout(() => resultCallback(outcome), 1); },
        shutdown: async () => { order.push("shutdown"); },
      };
      const tracing = buildTracing(config, inner);
      endSpans(tracing, ["d".repeat(16)]);
      await tracing.shutdown().catch(() => {});
      expect(order).toEqual(["export", "shutdown"]);
    },
  );

  it("buildTracingWith without a delivery set reports nothing as delivered", () => {
    const tracing = buildTracingWith(new SimpleSpanProcessor(new ScriptedExporter()), new PrimedIdGenerator());
    expect(tracing.delivered.size).toBe(0);
  });
});
