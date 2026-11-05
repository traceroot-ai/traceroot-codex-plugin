import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { dispatch } from "../src/emit.js";
import { buildTracing } from "../src/exporter.js";
import { makeSpanId } from "../src/ids.js";
import { loadEmittedSpanIds } from "../src/sidecar.js";
import { copyFixture, failed, ids, OK, ScriptedExporter, testConfig, writeRollout } from "./helpers.js";

const config = testConfig();

// rollout-basic.jsonl plans one completed turn: root AGENT, one LLM step, one TOOL.
const ROOT = makeSpanId("turn-1:root");
const STEP = makeSpanId("turn-1:step:0");
const TOOL = makeSpanId("call-1");

const deps = (exporter: ScriptedExporter) => ({
  buildTracing: (c: Config) => buildTracing(c, exporter),
  getGit: async () => ({}),
});

const sidecar = async (transcript: string) => [...(await loadEmittedSpanIds(transcript))].sort();

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
    ["a 413 response", () => failed("Request Entity Too Large", 413)],
    ["a 503 response", () => failed("Service Unavailable", 503)],
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
});

describe("dispatch records spans as each request is accepted", () => {
  it("keeps a request's spans recorded when the hook is killed during a later request", async () => {
    const transcript = await copyFixture();
    // A collector that accepts the first request and holds later ones until released.
    const held: Array<() => void> = [];
    let holding = true;
    let laterArrived!: () => void;
    const arrived = new Promise<void>((resolve) => { laterArrived = resolve; });
    let requests = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const accept = () => { res.writeHead(200, { "content-type": "application/x-protobuf" }); res.end(); };
        if (++requests === 1 || !holding) return accept();
        held.push(accept);
        laterArrived();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // One span per request, sent through the tracing a hook builds by default.
      const hook = dispatch({ transcript_path: transcript }, { ...config, hostUrl: `http://127.0.0.1:${port}`, maxRequestBytes: 1 },
        { getGit: async () => ({}) });
      await arrived;
      // A hook killed now, at Codex's deadline, has recorded the request that was accepted.
      expect(await sidecar(transcript)).toHaveLength(1);

      holding = false;
      for (const accept of held.splice(0)) accept();
      expect((await hook).emitted).toBe(3);
      expect(requests).toBe(3);
      expect(await sidecar(transcript)).toEqual([ROOT, STEP, TOOL].sort());
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// More spans in a single hook than one request carries, so they go out as a
// request of 1,024 spans and a second one. A failure in either fails dispatch.
describe("dispatch with more spans than one request carries", () => {
  const TOOL_CALLS = 1100; // + root + one LLM step = 1,102 spans

  async function writeBigRollout(): Promise<string> {
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
    return writeRollout(lines);
  }

  it("a failed first request is left unmarked and re-sent, and dispatch fails", async () => {
    const transcript = await writeBigRollout();
    let call = 0;
    const exporter = new ScriptedExporter(() => (++call === 1 ? failed("Service Unavailable", 503) : OK));

    await expect(dispatch({ transcript_path: transcript }, config, deps(exporter))).rejects.toBeDefined();
    expect(exporter.calls.map((c) => c.length)).toEqual([1024, TOOL_CALLS + 2 - 1024]);
    const firstBatch = ids(exporter.calls[0]!);
    expect(await sidecar(transcript)).toEqual(ids(exporter.calls[1]!).sort());

    const retry = new ScriptedExporter();
    await dispatch({ transcript_path: transcript }, config, deps(retry));
    expect(ids(retry.calls.flat()).sort()).toEqual([...firstBatch].sort());
  });

  it("a failed final request does not cause the accepted first request to be re-sent", async () => {
    const transcript = await writeBigRollout();
    let call = 0;
    const exporter = new ScriptedExporter(() => (++call === 2 ? failed("Service Unavailable", 503) : OK));

    await expect(dispatch({ transcript_path: transcript }, config, deps(exporter))).rejects.toBeDefined();
    expect(exporter.calls).toHaveLength(2);
    const [firstBatch, finalBatch] = [ids(exporter.calls[0]!), ids(exporter.calls[1]!)];
    expect(await sidecar(transcript)).toEqual([...firstBatch].sort());

    // Only the rejected request goes again, plus the always re-sent root.
    const retry = new ScriptedExporter();
    await dispatch({ transcript_path: transcript }, config, deps(retry));
    expect(ids(retry.calls.flat()).sort()).toEqual([...finalBatch, makeSpanId("big:root")].sort());
  });
});
