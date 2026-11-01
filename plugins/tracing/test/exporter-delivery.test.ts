import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  type ReadableSpan, type SpanExporter, BatchSpanProcessor, SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { buildTracing, buildTracingWith, DeliveryTrackingExporter, type Tracing } from "../src/exporter.js";
import { PrimedIdGenerator } from "../src/ids.js";
import { failed, ids, OK, ScriptedExporter } from "./helpers.js";

const config: Config = {
  enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 20000, debug: false, failOnError: false,
};

/** Ends one span per id through `tracing`, with the id primed like emitSpan does. */
function endSpans(tracing: Tracing, spanIds: string[]): void {
  for (const id of spanIds) {
    tracing.idGen.nextSpanId = id;
    tracing.tracer.startSpan(`span-${id}`).end();
  }
}

function exportOnce(exporter: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> {
  return new Promise((resolve) => exporter.export(spans, resolve));
}

/** Real ReadableSpans with the given ids, captured from a throwaway provider. */
async function makeSpans(spanIds: string[]): Promise<ReadableSpan[]> {
  const sink = new ScriptedExporter();
  const tracing = buildTracingWith(new SimpleSpanProcessor(sink), new PrimedIdGenerator());
  endSpans(tracing, spanIds);
  await tracing.shutdown();
  return sink.calls.flat();
}

describe("DeliveryTrackingExporter", () => {
  it("records the ids of a successful export and passes the result through", async () => {
    const spans = await makeSpans(["1".repeat(16), "2".repeat(16)]);
    const tracked = new DeliveryTrackingExporter(new ScriptedExporter());
    expect(await exportOnce(tracked, spans)).toEqual(OK);
    expect([...tracked.delivered].sort()).toEqual(["1".repeat(16), "2".repeat(16)]);
  });

  it("records nothing for a failed export (e.g. a 413 or 503 from the backend)", async () => {
    const spans = await makeSpans(["3".repeat(16)]);
    const tracked = new DeliveryTrackingExporter(new ScriptedExporter(() => failed("Request Entity Too Large")));
    const result = await exportOnce(tracked, spans);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error?.message).toBe("Request Entity Too Large");
    expect(tracked.delivered.size).toBe(0);
  });

  it("reports a throwing exporter as a failed export instead of throwing", async () => {
    const spans = await makeSpans(["4".repeat(16)]);
    const tracked = new DeliveryTrackingExporter(new ScriptedExporter(() => "throw"));
    const result = await exportOnce(tracked, spans);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error?.message).toBe("exporter crashed");
    expect(tracked.delivered.size).toBe(0);
  });

  it("wraps a non-Error throw in an Error", async () => {
    const inner: SpanExporter = {
      export: () => { throw "boom"; },
      shutdown: async () => {},
    };
    const result = await exportOnce(new DeliveryTrackingExporter(inner), []);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("boom");
  });

  it("forwards shutdown and forceFlush to the wrapped exporter", async () => {
    const inner = { export: vi.fn(), shutdown: vi.fn(async () => {}), forceFlush: vi.fn(async () => {}) };
    const tracked = new DeliveryTrackingExporter(inner);
    await tracked.forceFlush();
    await tracked.shutdown();
    expect(inner.forceFlush).toHaveBeenCalledTimes(1);
    expect(inner.shutdown).toHaveBeenCalledTimes(1);
  });

  it("forceFlush resolves when the wrapped exporter has none", async () => {
    const tracked = new DeliveryTrackingExporter({ export: vi.fn(), shutdown: async () => {} });
    await expect(tracked.forceFlush()).resolves.toBeUndefined();
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

  it("buildTracingWith without a delivery set reports nothing as delivered", () => {
    const tracing = buildTracingWith(new SimpleSpanProcessor(new ScriptedExporter()), new PrimedIdGenerator());
    expect(tracing.delivered.size).toBe(0);
  });

  it("shutdown rejects on a failed batch only after the exports still in flight are answered", async () => {
    const [a, b, c] = ["d".repeat(16), "e".repeat(16), "f".repeat(16)];
    // `a` fills a one-span batch and is exported at once; `b` and `c` are flushed
    // as two concurrent batches. `b` fails at once, `a` and `c` succeed later.
    const sink = new ScriptedExporter(
      (spans) => (ids(spans).includes(b) ? failed("Request Entity Too Large") : OK),
      (spans) => (ids(spans).includes(b) ? 0 : 20),
    );
    const tracked = new DeliveryTrackingExporter(sink);
    const tracing = buildTracingWith(
      new BatchSpanProcessor(tracked, { maxExportBatchSize: 1 }), new PrimedIdGenerator(), tracked.delivered,
    );
    endSpans(tracing, [a, b, c]);

    await expect(tracing.shutdown()).rejects.toBeDefined();
    expect(sink.calls).toHaveLength(3);
    expect([...tracing.delivered].sort()).toEqual([a, c]);
  });
});
