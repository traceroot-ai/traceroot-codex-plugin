import type { Tracer } from "@opentelemetry/api";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
// Protobuf exporter (Content-Type: application/x-protobuf). The TraceRoot ingest
// endpoint /api/v1/public/traces accepts OTLP protobuf ONLY (it 415s JSON), and
// the traceroot-ts SDK uses this same proto exporter — keep them aligned.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { ReadableSpan, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Config } from "./config.js";
import { PrimedIdGenerator } from "./ids.js";
import { SDK_NAME, SDK_VERSION } from "./sdk.js";
import { splitBySize } from "./size.js";

export type Tracing = {
  tracer: Tracer;
  idGen: PrimedIdGenerator;
  /** Ids of the spans whose export the exporter reported as successful. */
  delivered: ReadonlySet<string>;
  shutdown: () => Promise<void>;
};

/** Keeps every ended span, so the hook can send them all once it has ended them. */
class CollectingProcessor implements SpanProcessor {
  readonly spans: ReadableSpan[] = [];
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    this.spans.push(span);
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

/** One export call; a throwing exporter is reported as a failed export. */
export function exportOnce(exporter: SpanExporter, spans: ReadableSpan[]): Promise<ExportResult> {
  return new Promise((resolve) => {
    try {
      exporter.export(spans, resolve);
    } catch (error) {
      resolve({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
    }
  });
}

// The most spans one request carries, however small they are, so the ingest
// endpoint never gets an unbounded number of spans in one request.
const MAX_SPANS_PER_REQUEST = 1024;

/**
 * Sends `spans` as sequential requests of at most 1,024 spans whose estimated size
 * stays within `maxBytes`, to keep each request under the ingest endpoint's size
 * limit; a span whose estimate alone passes `maxBytes` goes in a request of its own.
 * Adds the ids of each accepted request to `delivered`, so a span counts as sent
 * only once the backend accepted it. A failed request fails only its own spans:
 * every request is tried, then the first failure is thrown.
 */
export async function sendInRequests(
  exporter: SpanExporter, spans: ReadableSpan[], maxBytes: number, delivered: Set<string>,
): Promise<void> {
  let failure: ExportResult | undefined;
  // One request at a time, so a hook has at most one request body, of up to
  // max_request_bytes, in flight at the ingest endpoint.
  for (const request of splitBySize(spans, maxBytes, MAX_SPANS_PER_REQUEST)) {
    const result = await exportOnce(exporter, request);
    if (result.code !== ExportResultCode.SUCCESS) {
      failure ??= result;
      continue;
    }
    for (const span of request) delivered.add(span.spanContext().spanId);
  }
  if (failure) throw failure.error ?? new Error("span export failed");
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
  // A hook ends every span before it sends any, so the spans are collected and
  // sent at shutdown, one request at a time. Nothing goes out earlier and nothing
  // is dropped, and shutdown sees the result of every request.
  const collected = new CollectingProcessor();
  const delivered = new Set<string>();
  return {
    ...buildTracingWith(collected, new PrimedIdGenerator(), delivered),
    shutdown: async () => {
      try {
        await sendInRequests(exporter, collected.spans, config.maxRequestBytes, delivered);
      } finally {
        await exporter.shutdown();
      }
    },
  };
}
