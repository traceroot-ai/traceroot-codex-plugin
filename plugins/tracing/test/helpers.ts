import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { InMemorySpanExporter, ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import type { Config } from "../src/config.js";
import { buildTracing, type Tracing } from "../src/exporter.js";

export const OK: ExportResult = { code: ExportResultCode.SUCCESS };

/** A failed export; `code` is the HTTP status, set on the error as the OTLP exporter does. */
export const failed = (message: string, code?: number): ExportResult => ({
  code: ExportResultCode.FAILED, error: Object.assign(new Error(message), code === undefined ? {} : { code }),
});

export const ids = (spans: ReadableSpan[]): string[] => spans.map((s) => s.spanContext().spanId);

/** A config with tracing on and a host nothing listens on, with `overrides` applied. */
export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 20000, debug: false, failOnError: true,
  ...overrides,
});

/** Copies fixtures/`name` into a temp dir that is removed after the test, and returns the copy's path. */
export async function copyFixture(name = "rollout-basic.jsonl"): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-fixture-"));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copy = path.join(dir, name);
  fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", name), copy);
  return copy;
}

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
 * The tracing a hook builds, sending its spans into `mem`. It never shuts `mem`
 * down: that would clear InMemorySpanExporter, and tests read the spans after dispatch.
 */
export function memTracing(mem: InMemorySpanExporter): Tracing {
  const keep: SpanExporter = { export: (spans, done) => mem.export(spans, done), shutdown: async () => {} };
  return buildTracing(testConfig(), keep);
}
