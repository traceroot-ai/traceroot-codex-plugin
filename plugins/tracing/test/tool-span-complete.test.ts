/**
 * When a tool span is complete enough to send. A resumed session with legacy
 * history records an MCP call's end event when the tool returns, runs PostToolUse,
 * and only then records the output item, which carries the output and its images.
 * A span sent at the end event would be marked sent and never sent again.
 */
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dispatch } from "../src/emit.js";
import { makeSpanId } from "../src/ids.js";
import { memExporter, testConfig, writeRollout } from "./helpers.js";

const png = /data:image\/png;base64,[A-Za-z0-9+/]+=*/.exec(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rollout-tool-image.jsonl"), "utf-8",
))![0];

const line = (ms: number, type: string, payload: Record<string, unknown>) =>
  ({ timestamp: new Date(Date.UTC(2026, 6, 1, 12, 0, 0, ms)).toISOString(), type, payload });
const append = (file: string, lines: unknown[]) =>
  fs.appendFileSync(file, `\n${lines.map((l) => JSON.stringify(l)).join("\n")}`);

const OUTPUT = "traceroot.span.output";
const tools = (mem: InMemorySpanExporter) =>
  mem.getFinishedSpans().filter((s) => s.attributes["traceroot.span.type"] === "TOOL");
const deps = (mem: InMemorySpanExporter) => ({ exporter: () => memExporter(mem), getGit: async () => ({}) });

// A screenshot tool call, up to its end event: the PostToolUse hook comes here.
const throughEndEvent = [
  line(0, "session_meta", { id: "sess-shot", cwd: "/repo" }),
  line(10, "event_msg", { type: "task_started", turn_id: "turn-shot" }),
  line(20, "turn_context", { turn_id: "turn-shot", model: "gpt-5.5" }),
  line(100, "event_msg", { type: "user_message", message: "take a screenshot" }),
  line(1000, "response_item", { type: "function_call", name: "mcp__browser__screenshot", call_id: "call-shot", arguments: "{}" }),
  line(1100, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 10 } } }),
  line(1500, "event_msg", { type: "mcp_tool_call_end", call_id: "call-shot", duration: { secs: 0, nanos: 0 } }),
];
const outputAndTurnEnd = [
  line(1600, "response_item", {
    type: "function_call_output", call_id: "call-shot",
    output: [{ type: "input_text", text: "Captured" }, { type: "input_image", image_url: png, detail: "auto" }],
  }),
  line(3000, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }),
  line(3100, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 20 } } }),
  line(3200, "event_msg", { type: "task_complete", turn_id: "turn-shot", last_agent_message: "Done." }),
];

describe("a tool call whose end event comes before its output item", () => {
  it.each([true, false])("is sent once, with its output, after the output item (capture_images %s)", async (captureImages) => {
    const config = testConfig({ captureImages });
    const mem = new InMemorySpanExporter();
    const transcript = await writeRollout(throughEndEvent);

    await dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, config, deps(mem));
    expect(tools(mem)).toHaveLength(0);

    append(transcript, outputAndTurnEnd);
    await dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, config, deps(mem));
    const [tool, ...others] = tools(mem);
    expect(others).toHaveLength(0);
    expect(String(tool!.attributes[OUTPUT])).toContain("Captured");
    if (captureImages) expect(String(tool!.attributes[OUTPUT])).toContain(png);
    expect(JSON.parse(String(tool!.attributes["traceroot.span.metadata"]))).toMatchObject({ tool_kind: "mcp" });
  });

  it("is sent by the next hook once its output item is read, while the turn still runs", async () => {
    const mem = new InMemorySpanExporter();
    const transcript = await writeRollout([...throughEndEvent, outputAndTurnEnd[0]]);

    await dispatch({ transcript_path: transcript, hook_event_name: "PostToolUse" }, testConfig(), deps(mem));
    const [tool, ...others] = tools(mem);
    expect(others).toHaveLength(0);
    expect(String(tool!.attributes[OUTPUT])).toContain("Captured");
  });

  it("is sent at Stop, without an output, when the turn is interrupted before the output item", async () => {
    const mem = new InMemorySpanExporter();
    const transcript = await writeRollout([
      ...throughEndEvent, line(1700, "event_msg", { type: "turn_aborted", turn_id: "turn-shot", reason: "interrupted" }),
    ]);

    await dispatch({ transcript_path: transcript, hook_event_name: "Stop" }, testConfig(), deps(mem));
    const [tool, ...others] = tools(mem);
    expect(others).toHaveLength(0);
    expect(tool!.spanContext().spanId).toBe(makeSpanId("call-shot"));
    expect(tool!.attributes[OUTPUT]).toBeUndefined();
  });
});

describe("a subagent's tool call still running when the parent's turn ends", () => {
  it("is not sent at the parent's Stop, and goes out with its output once that arrives", async () => {
    const parent = await writeRollout([
      line(0, "session_meta", { id: "sess-parent", cwd: "/repo" }),
      line(10, "event_msg", { type: "task_started", turn_id: "turn-parent" }),
      line(100, "event_msg", { type: "user_message", message: "start a helper" }),
      line(1000, "response_item", { type: "function_call", name: "spawn_agent", call_id: "call-spawn", arguments: "{}" }),
      line(1100, "event_msg", { type: "collab_agent_spawn_end", call_id: "call-spawn", new_thread_id: "thread-child" }),
      line(1200, "response_item", { type: "function_call_output", call_id: "call-spawn", output: "{\"agent_id\":\"thread-child\"}" }),
      line(1300, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 10 } } }),
      line(1400, "event_msg", { type: "task_complete", turn_id: "turn-parent", last_agent_message: "Started." }),
    ]);
    const child = await writeRollout([
      line(1150, "session_meta", { id: "sess-child", cwd: "/repo" }),
      line(1160, "event_msg", { type: "task_started", turn_id: "turn-child" }),
      line(1170, "event_msg", { type: "user_message", message: "list the files" }),
      line(1180, "response_item", { type: "function_call", name: "exec_command", call_id: "call-ls", arguments: "{}" }),
    ]);
    const mem = new InMemorySpanExporter();
    const childDeps = { ...deps(mem), findSubagent: async (id: string) => (id === "thread-child" ? child : undefined) };
    const lsSpanId = makeSpanId("thread-child:call-ls");

    await dispatch({ transcript_path: parent, hook_event_name: "Stop" }, testConfig(), childDeps);
    expect(tools(mem).map((s) => s.spanContext().spanId)).not.toContain(lsSpanId);

    append(child, [
      line(2000, "response_item", { type: "function_call_output", call_id: "call-ls", output: "file.txt" }),
      line(2100, "event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 20 } } }),
      line(2200, "event_msg", { type: "task_complete", turn_id: "turn-child", last_agent_message: "Done." }),
    ]);
    await dispatch({ transcript_path: parent, hook_event_name: "SubagentStop" }, testConfig(), childDeps);
    const ls = tools(mem).filter((s) => s.spanContext().spanId === lsSpanId);
    expect(ls).toHaveLength(1);
    expect(String(ls[0]!.attributes[OUTPUT])).toContain("file.txt");
  });
});
