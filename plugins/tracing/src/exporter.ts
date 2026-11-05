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

/** One export call; a throwing exporter is reported as a failed export. */
function exportSafely(
  exporter: SpanExporter, spans: ReadableSpan[], resultCallback: (result: ExportResult) => void,
): void {
  try {
    exporter.export(spans, resultCallback);
  } catch (error) {
    resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
  }
}

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
 * Sends `spans` as sequential requests of at most 1,024 spans and adds the ids of
 * each accepted request to `delivered`, so a span counts as sent only once the
 * backend accepted it. A failed request fails only its own spans: every request is
 * tried, then the first failure is thrown.
 */
export async function sendInRequests(
  exporter: SpanExporter, spans: ReadableSpan[], delivered: Set<string>,
): Promise<void> {
  let failure: ExportResult | undefined;
  for (let i = 0; i < spans.length; i += MAX_SPANS_PER_REQUEST) {
    const request = spans.slice(i, i + MAX_SPANS_PER_REQUEST);
    const result = await exportOnce(exporter, request);
    if (result.code !== ExportResultCode.SUCCESS) {
      failure ??= result;
      continue;
    }
    for (const span of request) delivered.add(span.spanContext().spanId);
  }
  if (failure) throw failure.error ?? new Error("span export failed");
}

/**
 * Sends each export call as sequential requests whose estimated size stays within
 * `maxBytes`, to keep each request under the ingest endpoint's size limit. A span
 * whose estimate alone passes `maxBytes` is still sent, in a request of its own. Each
 * request goes through `inner` on its own, so a failed request fails only its own
 * spans; the call as a whole reports the first failure, after trying every request.
 */
export class SizeLimitedExporter implements SpanExporter {
  // Export calls whose requests are still being sent. The batch processor exports
  // a full batch as soon as it fills, outside its final flush, so shutdown and
  // forceFlush wait for these before reaching `inner`.
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly inner: SpanExporter, private readonly maxBytes: number) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const call = this.exportInRequests(spans).then(resultCallback);
    this.inFlight.add(call);
    void call.finally(() => this.inFlight.delete(call));
  }

  private async exportInRequests(spans: ReadableSpan[]): Promise<ExportResult> {
    let firstFailure: ExportResult | undefined;
    for (const request of splitBySize(spans, this.maxBytes)) {
      const result = await new Promise<ExportResult>((resolve) => exportSafely(this.inner, request, resolve));
      if (result.code !== ExportResultCode.SUCCESS) firstFailure ??= result;
    }
    return firstFailure ?? { code: ExportResultCode.SUCCESS };
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.inFlight);
    await this.inner.shutdown();
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.inFlight);
    await this.inner.forceFlush?.();
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
  // A hook ends every span before it sends any, so the spans are collected and
  // sent at shutdown, one request at a time. Nothing goes out earlier and nothing
  // is dropped, and shutdown sees the result of every request.
  const collected = new CollectingProcessor();
  const delivered = new Set<string>();
  return {
    ...buildTracingWith(collected, new PrimedIdGenerator(), delivered),
    shutdown: async () => {
      try {
        await sendInRequests(exporter, collected.spans, delivered);
      } finally {
        await exporter.shutdown();
      }
    },
  };
}
