import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  type InMemorySpanExporter, type ReadableSpan, type SpanExporter, SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { buildTracingWith, DeliveryTrackingExporter, type Tracing } from "../src/exporter.js";
import { PrimedIdGenerator } from "../src/ids.js";

export const OK: ExportResult = { code: ExportResultCode.SUCCESS };

export const failed = (message: string): ExportResult => ({ code: ExportResultCode.FAILED, error: new Error(message) });

export const ids = (spans: ReadableSpan[]): string[] => spans.map((s) => s.spanContext().spanId);

/**
 * Records every export call and answers it with `outcome(spans)` after
 * `delayMs(spans)` (a tick by default), like a network exporter would. `"throw"`
 * makes `export` itself throw. Like the OTLP exporter, shutdown waits until every
 * export call has been answered.
 */
export class ScriptedExporter implements SpanExporter {
  readonly calls: ReadableSpan[][] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly outcome: (spans: ReadableSpan[]) => ExportResult | "throw" = () => OK,
    private readonly delayMs: (spans: ReadableSpan[]) => number = () => 0,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.calls.push(spans);
    const result = this.outcome(spans);
    if (result === "throw") throw new Error("exporter crashed");
    const answered = new Promise<void>((resolve) => setTimeout(() => {
      resultCallback(result);
      resolve();
    }, this.delayMs(spans)));
    this.inFlight.add(answered);
    void answered.then(() => this.inFlight.delete(answered));
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.inFlight);
  }
}

/**
 * Tracing that exports each span into `mem` as it ends and tracks delivery the
 * way buildTracing does. Its shutdown only flushes: provider.shutdown() would
 * clear InMemorySpanExporter, and tests read the spans after dispatch.
 */
export function memTracing(mem: InMemorySpanExporter): Tracing {
  const tracked = new DeliveryTrackingExporter(mem);
  const processor = new SimpleSpanProcessor(tracked);
  return {
    ...buildTracingWith(processor, new PrimedIdGenerator(), tracked.delivered),
    shutdown: () => processor.forceFlush(),
  };
}
