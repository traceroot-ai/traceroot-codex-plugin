import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { type ReadableSpan, type SpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { buildTracingWith, DeliveryTrackingExporter, SizeLimitedExporter } from "../src/exporter.js";
import { PrimedIdGenerator } from "../src/ids.js";
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
