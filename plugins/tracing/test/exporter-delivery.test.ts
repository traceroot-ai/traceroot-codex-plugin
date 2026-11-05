import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { buildTracing, exportOnce, sendInRequests } from "../src/exporter.js";
import { distinctIds, endSpans, failed, ids, makeSpans, OK, recorder, ScriptedExporter, testConfig } from "./helpers.js";

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
    const { delivered, onDelivered } = recorder();
    await sendInRequests(inner, spans, { maxBytes: BUDGET, onDelivered });
    expect(inner.calls).toEqual([spans]);
    expect([...delivered].sort()).toEqual(["1".repeat(16), "2".repeat(16)]);
  });

  it("rejects and records nothing for a failed request (e.g. a 413 or 503 from the backend)", async () => {
    const spans = await makeSpans(["3".repeat(16)]);
    const { delivered, onDelivered } = recorder();
    await expect(sendInRequests(new ScriptedExporter(() => failed("Request Entity Too Large")), spans, { maxBytes: BUDGET, onDelivered }))
      .rejects.toThrow("Request Entity Too Large");
    expect(delivered).toHaveLength(0);
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
    const { delivered, onDelivered } = recorder();

    await expect(sendInRequests(inner, spans, { maxBytes: BUDGET, onDelivered })).rejects.toThrow("Request Entity Too Large");
    expect(calls.map((c) => c.length)).toEqual([1024, 1024, 1]);
    expect(maxInFlight).toBe(1);
    expect([...delivered].sort()).toEqual(ids(calls[1]!).sort());
  });
});

describe("buildTracing collects the spans that sendInRequests delivers", () => {
  it("records the ids the exporter accepted once the collected spans are sent", async () => {
    const sink = new ScriptedExporter();
    const tracing = buildTracing();
    endSpans(tracing, ["a".repeat(16), "b".repeat(16)]);
    await tracing.shutdown();
    const { delivered, onDelivered } = recorder();
    await sendInRequests(sink, tracing.spans, { maxBytes: BUDGET, onDelivered });
    expect(ids(sink.calls.flat()).sort()).toEqual(["a".repeat(16), "b".repeat(16)]);
    expect([...delivered].sort()).toEqual(["a".repeat(16), "b".repeat(16)]);
  });

  it("rejects and nothing counts as delivered when the export fails", async () => {
    const tracing = buildTracing();
    endSpans(tracing, ["c".repeat(16)]);
    await tracing.shutdown();
    const { delivered, onDelivered } = recorder();
    await expect(sendInRequests(new ScriptedExporter(() => failed("Service Unavailable")), tracing.spans, { maxBytes: BUDGET, onDelivered }))
      .rejects.toBeDefined();
    expect(delivered).toHaveLength(0);
  });

  it("keeps every span through shutdown, then they go in requests of at most 1,024", async () => {
    const sink = new ScriptedExporter();
    const tracing = buildTracing();
    const sent = distinctIds(2049);
    endSpans(tracing, sent);
    await tracing.shutdown();
    expect(ids(tracing.spans)).toEqual(sent);

    const { delivered, onDelivered } = recorder();
    await sendInRequests(sink, tracing.spans, { maxBytes: BUDGET, onDelivered });
    expect(sink.calls.map((c) => c.length)).toEqual([1024, 1024, 1]);
    expect(ids(sink.calls.flat())).toEqual(sent);
    expect(delivered).toHaveLength(2049);
  });
});
