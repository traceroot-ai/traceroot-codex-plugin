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

export type SendOptions = {
  maxBytes: number;
  /** Whether this hook still holds the session's lock, checked right before each request. */
  stillHeld?: () => Promise<boolean>;
  /** Records the span ids of an accepted request, before the next request goes out. */
  onDelivered?: (ids: string[]) => Promise<void>;
};

/**
 * Sends `spans` as sequential requests of at most 1,024 spans whose estimated size
 * stays within `maxBytes`, to keep each request under the ingest endpoint's size
 * limit; a span whose estimate alone passes `maxBytes` goes in a request of its own.
 * Passes the ids of each accepted request to `onDelivered`, so a span counts as sent
 * only once the backend accepted it. A failed request fails only its own spans:
 * every request is tried, then the first failure is thrown. A request that
 * `stillHeld` holds back fails too, so the next hook sends its spans.
 */
export async function sendInRequests(
  exporter: SpanExporter, spans: ReadableSpan[], opts: SendOptions,
): Promise<void> {
  let failure: ExportResult | undefined;
  // One request at a time, so a hook has at most one request body, of up to
  // max_request_bytes, in flight at the ingest endpoint.
  for (const request of splitBySize(spans, opts.maxBytes, MAX_SPANS_PER_REQUEST)) {
    // A hook that froze and lost the session's lock must not send what it read.
    if (opts.stillHeld && !(await opts.stillHeld())) {
      failure ??= { code: ExportResultCode.FAILED, error: new Error("not sent: the session lock was taken over") };
      continue;
    }
    const result = await exportOnce(exporter, request);
    if (result.code !== ExportResultCode.SUCCESS) {
      failure ??= result;
      continue;
    }
    await opts.onDelivered?.(request.map((span) => span.spanContext().spanId));
  }
  if (failure) throw failure.error ?? new Error("span export failed");
}

export function buildTracingWith(processor: SpanProcessor, idGen: PrimedIdGenerator): Tracing {
  const provider = new NodeTracerProvider({ idGenerator: idGen, spanProcessors: [processor] });
  return {
    tracer: provider.getTracer(SDK_NAME, SDK_VERSION),
    idGen,
    // Both needed: forceFlush drains pending spans, shutdown awaits in-flight
    // OTLP HTTP delivery so this short-lived process delivers spans before exit.
    shutdown: async () => {
      await provider.forceFlush();
      await provider.shutdown();
    },
  };
}

export function otlpExporter(config: Config): SpanExporter {
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

export function buildTracing(): Tracing & { spans: ReadableSpan[] } {
  // A hook ends every span before it sends any, so the spans are only collected
  // here; the hook sends them all once they have ended (see sendInRequests).
  const collected = new CollectingProcessor();
  return { ...buildTracingWith(collected, new PrimedIdGenerator()), spans: collected.spans };
}
