import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import {
  type InMemorySpanExporter, type ReadableSpan, type SpanExporter, SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";
import type { Config } from "../src/config.js";
import { buildTracing, buildTracingWith, type Tracing } from "../src/exporter.js";
import { PrimedIdGenerator } from "../src/ids.js";
import { type EmitCtx, type EmittableSpan, planTurnSpans } from "../src/spans.js";
import { parseRollout, readRollout } from "../src/transcript.js";

export const OK: ExportResult = { code: ExportResultCode.SUCCESS };

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A failed export; `code` is the HTTP status, set on the error as the OTLP exporter does. */
export const failed = (message: string, code?: number): ExportResult => ({
  code: ExportResultCode.FAILED, error: Object.assign(new Error(message), code === undefined ? {} : { code }),
});

export const ids = (spans: ReadableSpan[]): string[] => spans.map((s) => s.spanContext().spanId);

/** A config with tracing on and a host nothing listens on, with `overrides` applied. */
export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 20000, maxRequestBytes: 12 * 1024 * 1024,
  debug: false, failOnError: true, captureImages: false,
  ...overrides,
});

/** A fresh temp dir, removed when the current test finishes. */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-test-"));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Copies fixtures/`name` into a temp dir that is removed after the test, and returns the copy's path. */
export async function copyFixture(name = "rollout-basic.jsonl"): Promise<string> {
  const copy = path.join(tempDir(), name);
  fs.copyFileSync(path.join(fixturesDir, name), copy);
  return copy;
}

/** Writes `lines` as a rollout in a temp dir that is removed after the test, and returns its path. */
export async function writeRollout(lines: unknown[]): Promise<string> {
  const file = path.join(tempDir(), "rollout.jsonl");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
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

/** `count` distinct span ids. */
export const distinctIds = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => (i + 1).toString(16).padStart(16, "0"));

/** Ends one span per id through `tracing`, primed like emitSpan does, each with `bytes` of output text. */
export function endSpans(tracing: Tracing, spanIds: string[], bytes = 0): void {
  for (const id of spanIds) {
    tracing.idGen.nextSpanId = id;
    tracing.tracer.startSpan(`span-${id}`, { attributes: { "traceroot.span.output": "x".repeat(bytes) } }).end();
  }
}

/** The real ReadableSpans that `end` ends through a throwaway tracing. */
export async function captureSpans(end: (tracing: Tracing) => void): Promise<ReadableSpan[]> {
  const sink = new ScriptedExporter();
  const tracing = buildTracingWith(new SimpleSpanProcessor(sink), new PrimedIdGenerator());
  end(tracing);
  await tracing.shutdown();
  return sink.calls.flat();
}

/** Real ReadableSpans with the given ids, each with `bytes` of output text. */
export const makeSpans = (spanIds: string[], bytes = 0): Promise<ReadableSpan[]> =>
  captureSpans((tracing) => endSpans(tracing, spanIds, bytes));

/**
 * The tracing a hook builds, sending its spans into `mem`. It never shuts `mem`
 * down: that would clear InMemorySpanExporter, and tests read the spans after dispatch.
 */
export function memTracing(mem: InMemorySpanExporter): Tracing {
  const keep: SpanExporter = { export: (spans, done) => mem.export(spans, done), shutdown: async () => {} };
  return buildTracing(testConfig(), keep);
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
  const file = path.join(fixturesDir, "spans-golden.json");
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, Record<string, unknown>>;
}

/** Every span planned from fixtures/`name`, turn by turn, in `ctx`. */
export async function planFixture(name: string, ctx: EmitCtx): Promise<EmittableSpan[]> {
  const { sessionMeta, turns } = parseRollout(await readRollout(path.join(fixturesDir, name)));
  return turns.flatMap((turn) => planTurnSpans(sessionMeta, turn, ctx));
}
