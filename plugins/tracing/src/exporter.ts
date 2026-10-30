import type { Tracer } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
// Protobuf exporter (Content-Type: application/x-protobuf). The TraceRoot ingest
// endpoint /api/v1/public/traces accepts OTLP protobuf ONLY (it 415s JSON), and
// the traceroot-ts SDK uses this same proto exporter — keep them aligned.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  type ReadableSpan, type SpanExporter, type SpanProcessor, BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Config } from "./config.js";
import { PrimedIdGenerator } from "./ids.js";
import { SDK_NAME, SDK_VERSION } from "./sdk.js";

export type Tracing = {
  tracer: Tracer;
  idGen: PrimedIdGenerator;
  /** Ids of the spans whose export the exporter reported as successful. */
  delivered: ReadonlySet<string>;
  shutdown: () => Promise<void>;
};

/**
 * Passes spans through to `inner` and records the ids of every span whose export
 * call succeeded, so a span is only treated as sent once the backend accepted it.
 * A throwing `inner.export` is reported as a failed export, never propagated.
 */
export class DeliveryTrackingExporter implements SpanExporter {
  readonly delivered = new Set<string>();

  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const done = (result: ExportResult): void => {
      if (result.code === ExportResultCode.SUCCESS) {
        for (const span of spans) this.delivered.add(span.spanContext().spanId);
      }
      resultCallback(result);
    };
    try {
      this.inner.export(spans, done);
    } catch (error) {
      done({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export function buildTracingWith(
  processor: SpanProcessor, idGen: PrimedIdGenerator, delivered: ReadonlySet<string> = new Set(),
): Tracing {
  const provider = new NodeTracerProvider({ idGenerator: idGen, spanProcessors: [processor] });
  return {
    tracer: provider.getTracer(SDK_NAME, SDK_VERSION),
    idGen,
    delivered,
    // Both needed: forceFlush drains pending spans, shutdown awaits in-flight
    // OTLP HTTP delivery so this short-lived process delivers spans before exit.
    shutdown: async () => {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

function otlpExporter(config: Config): SpanExporter {
  return new OTLPTraceExporter({
    url: `${config.hostUrl}/api/v1/public/traces`,
    headers: {
      Authorization: `Bearer ${config.apiKey ?? ""}`,
      "x-traceroot-sdk-name": SDK_NAME,
      "x-traceroot-sdk-version": SDK_VERSION,
    },
    compression: "gzip" as never,
  });
}

export function buildTracing(config: Config, exporter: SpanExporter = otlpExporter(config)): Tracing {
  const tracked = new DeliveryTrackingExporter(exporter);
  // Batch (not Simple): a hook invocation can complete many spans at once (a turn
  // with many tools, or a subagent's whole subtree). Simple sends one HTTP POST
  // per span, and a burst loses the tail before this short-lived process exits.
  // Batch coalesces them into few large OTLP POSTs that forceFlush ships reliably.
  // Liveness is unchanged: each hook invocation still flushes its spans on shutdown.
  const processor = new BatchSpanProcessor(tracked, {
    maxQueueSize: 4096,
    maxExportBatchSize: 1024,
    scheduledDelayMillis: 30000, // won't auto-fire in a short hook; we forceFlush on shutdown
  });
  return buildTracingWith(processor, new PrimedIdGenerator(), tracked.delivered);
}
