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
  enabled: true, apiKey: "tr-x", hostUrl: "http://127.0.0.1:9", maxChars: 20000, maxRequestBytes: 12 * 1024 * 1024, debug: false, failOnError: true,
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

// More than one 1,024-span batch in a single hook. The processor exports the
// first full batch as soon as it fills, outside the final flush, so a failure
// there does not make shutdown fail; a failure in the final flush does.
describe("dispatch with more spans than one export batch", () => {
  const TOOL_CALLS = 1100; // + root + one LLM step = 1,102 spans

  async function writeBigRollout(): Promise<string> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tr-batches-"));
    const transcript = path.join(dir, "rollout.jsonl");
    const lines: unknown[] = [
      { timestamp: "2026-06-30T00:00:00.000Z", type: "session_meta", payload: { id: "sess-batches" } },
      { timestamp: "2026-06-30T00:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "big" } },
    ];
    for (let i = 0; i < TOOL_CALLS; i++) {
      const call = { type: "function_call", name: "exec_command", call_id: `c${i}`, arguments: "{}" };
      lines.push({ timestamp: "2026-06-30T00:00:02.000Z", type: "response_item", payload: call });
      lines.push({
        timestamp: "2026-06-30T00:00:03.000Z", type: "response_item",
        payload: { type: "function_call_output", call_id: `c${i}`, output: "ok" },
      });
    }
    lines.push(
      { timestamp: "2026-06-30T00:00:04.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1 } } } },
      { timestamp: "2026-06-30T00:00:05.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "big" } },
    );
    await fs.writeFile(transcript, lines.map((l) => JSON.stringify(l)).join("\n"));
    return transcript;
  }

  it("a failed first batch is left unmarked and re-sent, although shutdown succeeds", async () => {
    const transcript = await writeBigRollout();
    let call = 0;
    const exporter = new ScriptedExporter(() => (++call === 1 ? httpError("Service Unavailable", 503) : OK));

    expect((await dispatch({ transcript_path: transcript }, config, deps(exporter))).emitted).toBe(TOOL_CALLS + 2);
    expect(exporter.calls.map((c) => c.length)).toEqual([1024, TOOL_CALLS + 2 - 1024]);
    const firstBatch = ids(exporter.calls[0]!);
    expect(await sidecar(transcript)).toEqual(ids(exporter.calls[1]!).sort());

    const retry = new ScriptedExporter();
    await dispatch({ transcript_path: transcript }, config, deps(retry));
    expect(ids(retry.calls.flat()).sort()).toEqual([...firstBatch].sort());
  });

  it("a failed final batch does not cause the accepted first batch to be re-sent", async () => {
    const transcript = await writeBigRollout();
    let call = 0;
    const exporter = new ScriptedExporter(() => (++call === 2 ? httpError("Service Unavailable", 503) : OK));

    await expect(dispatch({ transcript_path: transcript }, config, deps(exporter))).rejects.toBeDefined();
    expect(exporter.calls).toHaveLength(2);
    const [firstBatch, finalBatch] = [ids(exporter.calls[0]!), ids(exporter.calls[1]!)];
    expect(await sidecar(transcript)).toEqual([...firstBatch].sort());

    // Only the rejected batch goes again, plus the always re-sent root.
    const retry = new ScriptedExporter();
    await dispatch({ transcript_path: transcript }, config, deps(retry));
    expect(ids(retry.calls.flat()).sort()).toEqual([...finalBatch, makeSpanId("big:root")].sort());
  });

  it("a final batch that fails while the first is still in flight does not cause the first to be re-sent", async () => {
    const transcript = await writeBigRollout();
    // The final batch is rejected at once; the full first batch is accepted later.
    const exporter = new ScriptedExporter(
      (spans) => (spans.length === 1024 ? OK : httpError("Request Entity Too Large", 413)),
      (spans) => (spans.length === 1024 ? 50 : 0),
    );

    await expect(dispatch({ transcript_path: transcript }, config, deps(exporter))).rejects.toBeDefined();
    expect(exporter.calls.map((c) => c.length)).toEqual([1024, TOOL_CALLS + 2 - 1024]);
    const [firstBatch, finalBatch] = [ids(exporter.calls[0]!), ids(exporter.calls[1]!)];
    expect(await sidecar(transcript)).toEqual([...firstBatch].sort());

    const retry = new ScriptedExporter();
    await dispatch({ transcript_path: transcript }, config, deps(retry));
    expect(ids(retry.calls.flat()).sort()).toEqual([...finalBatch, makeSpanId("big:root")].sort());
  });
});
