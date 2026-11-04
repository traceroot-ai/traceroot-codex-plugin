import { describe, expect, it } from "vitest";
import { planTurnSpans, ROOT_NAME } from "../src/spans.js";
import { makeSpanId, makeTraceId } from "../src/ids.js";
import type { SessionMeta, ToolCall, Turn } from "../src/types.js";

const sessionMeta: SessionMeta = { sessionId: "sess-abc" };
const turn: Turn = {
  turnId: "turn-1", startTime: 1000, endTime: 4000, model: "gpt-5.5",
  userInput: "list the files", finalOutput: "two files", completed: true, aborted: false,
  steps: [{
    index: 0, startTime: 1500, endTime: 3200,
    text: "two files", reasoning: "ls",
    usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 40, reasoning_output_tokens: 10 },
    toolCalls: [{ callId: "call-1", name: "exec_command", args: { cmd: "ls" }, startTime: 1800, endTime: 2600, output: "a.txt" }],
  }],
};
const ctx = { environment: "production", git: { repo: "traceroot-ai/traceroot", ref: "a".repeat(40) }, maxChars: 20000 };

describe("planTurnSpans", () => {
  const spans = planTurnSpans(sessionMeta, turn, ctx);
  const byKind = (k: string) => spans.filter((s) => s.kind === k);

  it("emits AGENT + LLM + TOOL with the right tree", () => {
    const traceId = makeTraceId("sess-abc", "turn-1");
    expect(spans.every((s) => s.traceId === traceId)).toBe(true);

    const root = byKind("AGENT")[0]!;
    expect(root.spanId).toBe(makeSpanId("turn-1:root"));
    expect(root.parentSpanId).toBeNull();

    const llm = byKind("LLM")[0]!;
    expect(llm.parentSpanId).toBe(root.spanId);
    expect(llm.spanId).toBe(makeSpanId("turn-1:step:0"));

    const tool = byKind("TOOL")[0]!;
    expect(tool.parentSpanId).toBe(llm.spanId);
    expect(tool.spanId).toBe(makeSpanId("call-1"));
  });

  it("LLM span carries model + token attrs so the backend can cost it", () => {
    const llm = byKind("LLM")[0]!;
    expect(llm.attributes["traceroot.span.type"]).toBe("LLM");
    expect(llm.attributes["traceroot.llm.model"]).toBe("gpt-5.5");
    expect(llm.attributes["llm.token_count.prompt"]).toBe(1200);
    expect(llm.attributes["llm.token_count.completion"]).toBe(40);
    expect(llm.attributes["llm.token_count.prompt_details.cache_read"]).toBe(1000);
  });

  it("LLM span carries input + rich output (content/reasoning/tool_calls), never empty", () => {
    const llm = byKind("LLM")[0]!;
    // first step input = the user prompt
    expect(llm.attributes["traceroot.span.input"]).toBe("list the files");
    const output = JSON.parse(String(llm.attributes["traceroot.span.output"]));
    expect(output.content).toBe("two files");
    expect(output.reasoning).toBe("ls");
    expect(output.tool_calls).toEqual([{ name: "exec_command", args: { cmd: "ls" } }]);
    expect(JSON.parse(String(llm.attributes["traceroot.span.metadata"]))["codex.step_index"]).toBe(0);
  });

  it("root carries session id + git on root, session id on every span", () => {
    const root = byKind("AGENT")[0]!;
    expect(root.attributes["traceroot.trace.session_id"]).toBe("sess-abc");
    expect(root.attributes["traceroot.git.repo"]).toBe("traceroot-ai/traceroot");
    expect(root.attributes["traceroot.span.input"]).toBe("list the files");
    expect(spans.every((s) => s.attributes["traceroot.trace.session_id"] === "sess-abc")).toBe(true);
  });

  it("tool span carries name + io + type", () => {
    const tool = byKind("TOOL")[0]!;
    expect(tool.name).toBe("exec_command");
    expect(tool.attributes["traceroot.span.type"]).toBe("TOOL");
    expect(String(tool.attributes["traceroot.span.output"])).toContain("a.txt");
    expect(tool.complete).toBe(true);
  });

  it("every span carries traceroot.span.path with ROOT_NAME first (live trace title)", () => {
    // While the root span is deferred, the backend titles the trace from the
    // shallowest span's path[0] — so path[0] must be the root name on all spans.
    for (const s of spans) {
      const path = s.attributes["traceroot.span.path"];
      expect(Array.isArray(path)).toBe(true);
      expect((path as string[])[0]).toBe(ROOT_NAME);
    }
  });

  // Part 1 — the root is emitted (complete) only when the turn ENDS, so a
  // running turn leaves no completed root in ClickHouse and the live stream stays
  // open. ctx.turnEnding (the Stop hook) forces it even without task_complete.
  const rootComplete = (t: Turn, turnEnding: boolean) =>
    planTurnSpans(sessionMeta, t, { ...ctx, turnEnding }).find((s) => s.kind === "AGENT")!.complete;

  it("root is NOT complete mid-turn (not completed, not the Stop hook)", () => {
    expect(rootComplete({ ...turn, completed: false }, false)).toBe(false);
  });
  it("root IS complete on the Stop hook even if task_complete was missed", () => {
    expect(rootComplete({ ...turn, completed: false }, true)).toBe(true);
  });
  it("root IS complete when the turn completed cleanly", () => {
    expect(rootComplete({ ...turn, completed: true }, false)).toBe(true);
  });

  // Regression: a turn with no task_complete (aborted / live snapshot) has
  // endTime === startTime. The root must still span its latest child activity,
  // not render as a 0ms bar.
  it("root end covers latest child activity when the turn never completed", () => {
    const incomplete: Turn = {
      turnId: "turn-x", startTime: 1000, endTime: 1000, // never advanced (no task_complete)
      completed: false, aborted: false, subagents: [],
      steps: [{
        index: 0, startTime: 1200, endTime: 1800, toolCalls: [
          // e.g. wait_agent finishing when a subagent completes, long after start
          { callId: "c", name: "wait_agent", args: {}, startTime: 1300, endTime: 9000 },
        ],
      }],
    };
    const root = planTurnSpans(sessionMeta, incomplete, ctx).find((s) => s.kind === "AGENT")!;
    expect(root.startTime).toBe(1000);
    expect(root.endTime).toBe(9000); // covers the latest tool end, not 1000
  });
});

describe("planToolSpan enriched metadata", () => {
  it("emits traceroot.span.metadata with tool_kind, status, exit_code and error for a failed tool call", () => {
    const enrichedTurn: Turn = {
      ...turn,
      steps: [{
        ...turn.steps[0]!,
        toolCalls: [{
          callId: "call-fail",
          name: "exec",
          args: { cmd: "false" },
          startTime: 1800,
          endTime: 2000,
          kind: "exec",
          status: "failed",
          exitCode: 1,
          error: "boom",
        } satisfies ToolCall],
      }],
    };
    const spans = planTurnSpans(sessionMeta, enrichedTurn, ctx);
    const tool = spans.find((s) => s.kind === "TOOL")!;
    expect(tool).toBeDefined();
    const rawMeta = tool.attributes["traceroot.span.metadata"];
    expect(rawMeta).toBeDefined();
    const meta = JSON.parse(rawMeta as string) as Record<string, unknown>;
    expect(meta["tool_kind"]).toBe("exec");
    expect(meta["status"]).toBe("failed");
    expect(meta["exit_code"]).toBe(1);
    expect(String(meta["error"])).toContain("boom");
  });

  it("cuts a failed tool's error text at maxChars, so error output alone can't pass the upload limit", () => {
    const stderr = "e".repeat(17 * 1024 * 1024);
    const failedTurn: Turn = {
      ...turn,
      steps: [{
        ...turn.steps[0]!,
        toolCalls: [{
          callId: "call-fail", name: "exec", args: { cmd: "make" }, startTime: 1800, endTime: 2000,
          status: "failed", exitCode: 2, error: stderr,
        } satisfies ToolCall],
      }],
    };
    const tool = planTurnSpans(sessionMeta, failedTurn, ctx).find((s) => s.kind === "TOOL")!;
    const meta = JSON.parse(tool.attributes["traceroot.span.metadata"] as string) as Record<string, unknown>;
    expect(meta["error"]).toBe(`${"e".repeat(20000)}…[truncated ${stderr.length - 20000} chars]`);
    expect(meta["status"]).toBe("failed");
  });
});

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PrimedIdGenerator } from "../src/ids.js";
import { buildTracingWith } from "../src/exporter.js";
import { emitSpan } from "../src/spans.js";

describe("emitSpan", () => {
  it("emits a child whose parentSpanId matches the planned parent, before the parent exists", async () => {
    const mem = new InMemorySpanExporter();
    const tracing = buildTracingWith(new SimpleSpanProcessor(mem), new PrimedIdGenerator());
    const spans = planTurnSpans(sessionMeta, turn, ctx);
    const tool = spans.find((s) => s.kind === "TOOL")!;
    emitSpan(tracing, tool); // child emitted with no parent span object in-process
    const got = mem.getFinishedSpans()[0]!; // read before shutdown clears the exporter
    expect(got.spanContext().spanId).toBe(tool.spanId);
    expect(got.spanContext().traceId).toBe(tool.traceId);
    expect(got.parentSpanContext?.spanId).toBe(tool.parentSpanId);
    await tracing.shutdown();
  });
});
