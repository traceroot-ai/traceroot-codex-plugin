import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { BatchSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { dispatch } from "../src/emit.js";
import { buildTracing, buildTracingWith, DeliveryTrackingExporter } from "../src/exporter.js";
import { makeSpanId, PrimedIdGenerator } from "../src/ids.js";
import { loadEmittedSpanIds } from "../src/sidecar.js";
import { ids, OK, ScriptedExporter } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const config: Config = {
  enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 20000, debug: false, failOnError: true,
};

// rollout-basic.jsonl plans one completed turn: root AGENT, one LLM step, one TOOL.
const ROOT = makeSpanId("turn-1:root");
const STEP = makeSpanId("turn-1:step:0");
const TOOL = makeSpanId("call-1");

let dir: string;
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

async function copyFixture(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-delivery-"));
  const dst = path.join(dir, "rollout.jsonl");
  await fs.copyFile(path.join(here, "fixtures", "rollout-basic.jsonl"), dst);
  return dst;
}

const deps = (exporter: ScriptedExporter) => ({
  buildTracing: (c: Config) => buildTracing(c, exporter),
  getGit: async () => ({}),
});

const sidecar = async (transcript: string) => [...(await loadEmittedSpanIds(transcript))].sort();

const httpError = (message: string, code: number): ExportResult => ({
  code: ExportResultCode.FAILED, error: Object.assign(new Error(message), { code }),
});

describe("dispatch marks spans as sent only after their export succeeded", () => {
  it("marks every span once the export succeeds; the next hook re-sends only the root", async () => {
    const transcript = await copyFixture();
    const exporter = new ScriptedExporter();

    expect((await dispatch({ transcript_path: transcript }, config, deps(exporter))).emitted).toBe(3);
    expect(await sidecar(transcript)).toEqual([ROOT, STEP, TOOL].sort());

    const again = new ScriptedExporter();
    expect((await dispatch({ transcript_path: transcript }, config, deps(again))).emitted).toBe(1);
    expect(ids(again.calls.flat())).toEqual([ROOT]);
  });

  it.each<[string, (spans: ReadableSpan[]) => ExportResult | "throw"]>([
    ["a FAILED result", () => ({ code: ExportResultCode.FAILED })],
    ["a 413 response", () => httpError("Request Entity Too Large", 413)],
    ["a 503 response", () => httpError("Service Unavailable", 503)],
    ["a thrown error", () => "throw"],
  ])("marks nothing after %s, and re-sends every span on the next hook", async (_label, outcome) => {
    const transcript = await copyFixture();

    // The failure still surfaces from dispatch, so fail_on_error keeps working.
    await expect(dispatch({ transcript_path: transcript }, config, deps(new ScriptedExporter(outcome)))).rejects.toBeDefined();
    expect(await sidecar(transcript)).toEqual([]);

    const retry = new ScriptedExporter();
    expect((await dispatch({ transcript_path: transcript }, config, deps(retry))).emitted).toBe(3);
    expect(ids(retry.calls.flat()).sort()).toEqual([ROOT, STEP, TOOL].sort());
    expect(await sidecar(transcript)).toEqual([ROOT, STEP, TOOL].sort());
  });

  it("marks only the spans of the batches that succeeded", async () => {
    const transcript = await copyFixture();
    // One span per export call, and the call carrying the TOOL span fails.
    const exporter = new ScriptedExporter((spans) =>
      ids(spans).includes(TOOL) ? { code: ExportResultCode.FAILED } : OK);
    const perSpanBatches = {
      buildTracing: () => {
        const tracked = new DeliveryTrackingExporter(exporter);
        const processor = new BatchSpanProcessor(tracked, { maxExportBatchSize: 1 });
        return buildTracingWith(processor, new PrimedIdGenerator(), tracked.delivered);
      },
      getGit: async () => ({}),
    };

    await expect(dispatch({ transcript_path: transcript }, config, perSpanBatches)).rejects.toBeDefined();
    expect(exporter.calls).toHaveLength(3);
    expect(await sidecar(transcript)).toEqual([ROOT, STEP].sort());

    // The failed TOOL span is retried, alongside the always re-sent root.
    const retry = new ScriptedExporter();
    expect((await dispatch({ transcript_path: transcript }, config, deps(retry))).emitted).toBe(2);
    expect(ids(retry.calls.flat()).sort()).toEqual([ROOT, TOOL].sort());
  });

  it("does not mark a span the processor dropped, even though shutdown succeeded", async () => {
    const transcript = await copyFixture();
    const exporter = new ScriptedExporter();
    // A one-span queue overflows while the first export is in flight, so the
    // third span (TOOL) is dropped without any export error.
    const tinyQueue = {
      buildTracing: () => {
        const tracked = new DeliveryTrackingExporter(exporter);
        const processor = new BatchSpanProcessor(tracked, { maxQueueSize: 1, maxExportBatchSize: 1 });
        return buildTracingWith(processor, new PrimedIdGenerator(), tracked.delivered);
      },
      getGit: async () => ({}),
    };

    expect((await dispatch({ transcript_path: transcript }, config, tinyQueue)).emitted).toBe(3);
    expect(ids(exporter.calls.flat()).sort()).toEqual([ROOT, STEP].sort());
    expect(await sidecar(transcript)).toEqual([ROOT, STEP].sort());

    const retry = new ScriptedExporter();
    await dispatch({ transcript_path: transcript }, config, deps(retry));
    expect(ids(retry.calls.flat()).sort()).toEqual([ROOT, TOOL].sort());
  });
});
