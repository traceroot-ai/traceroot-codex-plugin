import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

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
