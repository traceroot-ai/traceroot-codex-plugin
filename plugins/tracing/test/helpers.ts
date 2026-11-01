import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  type InMemorySpanExporter, type ReadableSpan, type SpanExporter, SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTracingWith, DeliveryTrackingExporter, type Tracing } from "../src/exporter.js";
import { PrimedIdGenerator } from "../src/ids.js";
import type { EmitCtx } from "../src/spans.js";

export const OK: ExportResult = { code: ExportResultCode.SUCCESS };

export const failed = (message: string): ExportResult => ({ code: ExportResultCode.FAILED, error: new Error(message) });

export const ids = (spans: ReadableSpan[]): string[] => spans.map((s) => s.spanContext().spanId);

/**
 * Records every export call and answers it with `outcome(spans)`, after a tick
 * like a network exporter would. `"throw"` makes `export` itself throw.
 */
export class ScriptedExporter implements SpanExporter {
  readonly calls: ReadableSpan[][] = [];

  constructor(private readonly outcome: (spans: ReadableSpan[]) => ExportResult | "throw" = () => OK) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.calls.push(spans);
    const result = this.outcome(spans);
    if (result === "throw") throw new Error("exporter crashed");
    setTimeout(() => resultCallback(result), 0);
  }

  async shutdown(): Promise<void> {}
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

/**
 * The contexts fixtures/spans-golden.json was planned in. "full" mirrors a live
 * Stop hook with every context field set the way dispatch sets it by default,
 * image capture off included; "tight" leaves the optional fields unset and
 * truncates hard, so the truncation path is pinned too.
 */
export const GOLDEN_CONTEXTS: Record<string, EmitCtx> = {
  full: {
    environment: "dev", userId: "user-1", git: { repo: "traceroot-ai/traceroot", ref: "a".repeat(40) },
    maxChars: 20000, turnEnding: true, captureImages: false,
  },
  tight: { maxChars: 64 },
};

/** fixtures/spans-golden.json: each fixture's planned spans, by context name. */
export function readGolden(): Record<string, Record<string, unknown>> {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "spans-golden.json");
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, Record<string, unknown>>;
}
