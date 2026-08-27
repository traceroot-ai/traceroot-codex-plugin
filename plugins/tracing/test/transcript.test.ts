import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planTurnSpans } from "../src/spans.js";
import { parseRollout, readRollout } from "../src/transcript.js";
import type { RolloutLine } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "rollout-basic.jsonl");
const toolDetailFixture = path.join(here, "fixtures", "rollout-tool-detail.jsonl");

const ts = (sec: number): string => new Date(sec * 1000).toISOString();

describe("parseRollout", () => {
  it("reconstructs one completed turn with a tool call and usage", async () => {
    const lines = await readRollout(fixture);
    const { sessionMeta, turns } = parseRollout(lines);

    expect(sessionMeta.sessionId).toBe("sess-abc");
    expect(turns).toHaveLength(1);

    const t = turns[0]!;
    expect(t.turnId).toBe("turn-1");
    expect(t.model).toBe("gpt-5.5");
    expect(t.userInput).toBe("list the files");
    expect(t.completed).toBe(true);
    expect(t.finalOutput).toContain("two files");
    expect(t.steps).toHaveLength(1);

    const step = t.steps[0]!;
    expect(step.usage?.input_tokens).toBe(1200);
    expect(step.text).toContain("two files");
    expect(step.reasoning).toContain("ls");
    expect(step.toolCalls).toHaveLength(1);

    const tc = step.toolCalls[0]!;
    expect(tc.name).toBe("exec_command");
    expect(tc.callId).toBe("call-1");
    expect(tc.output).toContain("a.txt");
    expect(tc.endTime).toBeGreaterThan(tc.startTime);
  });

  it("captures the user prompt from response items", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>" }],
        },
      },
      {
        timestamp: ts(103),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "list the files" }] },
      },
      {
        timestamp: ts(104),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>\n  <current_date>2026-08-26</current_date>\n</environment_context>" }],
        },
      },
      {
        timestamp: ts(105),
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "two files" }] },
      },
      { timestamp: ts(106), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.userInput).toBe("list the files");
    expect(turns[0]!.finalOutput).toBe("two files");
  });

  it.each([
    "environment_context",
    "user_instructions",
    "subagent_notification",
    "user_shell_command",
    "recommended_plugins",
    "turn_aborted",
    "knowledge-context",
    "memory-context",
    "memory-cli",
    "activity-cli",
    "skill",
  ])("leaves input undefined when the turn only contains an injected <%s> block", (tag) => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `<${tag}>injected</${tag}>` }],
        },
      },
      { timestamp: ts(103), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.userInput).toBeUndefined();
  });

  it("prefers an authoritative user_message over an earlier response-item fallback", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<image name=[Image #1]></image>[Image #1] fix the parser" }],
        },
      },
      { timestamp: ts(103), type: "event_msg", payload: { type: "user_message", message: "[Image #1] fix the parser" } },
      { timestamp: ts(104), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBe("[Image #1] fix the parser");
  });

  it("rejects an AGENTS.md-prefixed injected wrapper in the fallback path", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>repo rules</INSTRUCTIONS>\n\n<environment_context>cwd=/repo</environment_context>",
          }],
        },
      },
      { timestamp: ts(103), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBeUndefined();
  });

  it("uses the real response-item prompt after an AGENTS.md-prefixed wrapper", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>repo rules</INSTRUCTIONS>\n\n<environment_context>cwd=/repo</environment_context>",
          }],
        },
      },
      {
        timestamp: ts(103),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the parser" }] },
      },
      { timestamp: ts(104), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBe("fix the parser");
  });

  it("keeps an authoritative prompt that merely mentions wrapper tags", () => {
    const prompt = "why does <environment_context> appear in my traces?";
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      },
      {
        timestamp: ts(103),
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "UserMessage", content: [{ type: "text", text: prompt }] },
        },
      },
      { timestamp: ts(104), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBe(prompt);
  });

  it("keeps a response-item fallback prompt that mentions a wrapper tag inline", () => {
    const prompt = "why does <environment_context> appear in my traces?";
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      },
      { timestamp: ts(103), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBe(prompt);
  });

  it("joins distinct authoritative prompts queued in the same turn", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: ts(102), type: "event_msg", payload: { type: "user_message", message: "build it locally" } },
      { timestamp: ts(103), type: "event_msg", payload: { type: "user_message", message: "delete node_modules before rerunning" } },
      { timestamp: ts(104), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBe("build it locally\n\ndelete node_modules before rerunning");
  });

  it("deduplicates the same prompt across authoritative event formats", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: ts(102), type: "event_msg", payload: { type: "user_message", message: "fix the parser" } },
      {
        timestamp: ts(103),
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "UserMessage", content: [{ type: "text", text: "fix the parser" }] },
        },
      },
      { timestamp: ts(104), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBe("fix the parser");
  });

  it("leaves legacy input undefined when user_message carries only injected context", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "event_msg",
        payload: { type: "user_message", message: "<knowledge-context>injected</knowledge-context>" },
      },
      { timestamp: ts(103), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBeUndefined();
  });

  it("does not let later user-role context replace the first prompt", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the parser" }] },
      },
      {
        timestamp: ts(103),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "later user-role context" }] },
      },
      { timestamp: ts(104), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBe("fix the parser");
  });

  it("preserves image markers that prefix a real user prompt", () => {
    const prompt = "<image name=[Image #1]></image>\nPlease inspect this screenshot";
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
      },
      { timestamp: ts(103), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);

    expect(turns[0]!.userInput).toBe(prompt);
  });

  it("does not throw and leaves text undefined when message content is missing", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: ts(102), type: "response_item", payload: { type: "message", role: "assistant" } as never },
      { timestamp: ts(103), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5 } } } },
      { timestamp: ts(104), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.steps).toHaveLength(1);
    expect(t.steps[0]!.text).toBeUndefined();
  });

  it("captures final output from agent_message even without task_complete (live-read race)", () => {
    // Codex writes agent_message BEFORE the terminal task_complete (which lands
    // just after the Stop hook fires). finalOutput must come from agent_message
    // so a live run's root span isn't empty. No task_complete line on purpose.
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: ts(102), type: "event_msg", payload: { type: "user_message", message: "hi" } },
      { timestamp: ts(103), type: "event_msg", payload: { type: "agent_message", message: "Hey there" } },
    ];
    const { turns } = parseRollout(lines);
    expect(turns[0]!.finalOutput).toBe("Hey there");
    expect(turns[0]!.completed).toBe(false); // still not marked complete (no task_complete)
  });

  it("uses the final assistant response as root output before task_complete arrives", () => {
    // Newer Codex versions can fire the Stop hook after the final assistant
    // response_item but before task_complete, without emitting agent_message.
    const lines: RolloutLine[] = [
      { timestamp: ts(100), type: "session_meta", payload: { id: "sess-1" } },
      { timestamp: ts(101), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        timestamp: ts(102),
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
      {
        timestamp: ts(103),
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking now" }] },
      },
      {
        timestamp: ts(104),
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5 } } },
      },
      {
        timestamp: ts(105),
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hey there" }] },
      },
    ];

    const { sessionMeta, turns } = parseRollout(lines);
    const turn = turns[0]!;
    const root = planTurnSpans(sessionMeta, turn, { maxChars: 20_000, turnEnding: true })[0]!;

    expect(turn.completed).toBe(false);
    expect(turn.finalOutput).toBe("Hey there");
    expect(root.attributes["traceroot.span.output"]).toBe("Hey there");
  });

  it("enriches tool calls from *_end event_msg events", async () => {
    const lines = await readRollout(toolDetailFixture);
    const { turns } = parseRollout(lines);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.steps).toHaveLength(1);
    const toolCalls = t.steps[0]!.toolCalls;
    expect(toolCalls).toHaveLength(2);

    // (a) successful exec
    const tcOk = toolCalls.find((tc) => tc.callId === "call-ok")!;
    expect(tcOk).toBeDefined();
    expect((tcOk as { kind?: string }).kind).toBe("exec");
    expect((tcOk as { status?: string }).status).toBe("completed");
    expect((tcOk as { exitCode?: number }).exitCode).toBe(0);
    expect(tcOk.endTime).toBeTruthy();
    expect(tcOk.error).toBeUndefined();

    // (b) failed exec
    const tcFail = toolCalls.find((tc) => tc.callId === "call-fail")!;
    expect(tcFail).toBeDefined();
    expect((tcFail as { kind?: string }).kind).toBe("exec");
    expect((tcFail as { status?: string }).status).toBe("failed");
    expect((tcFail as { exitCode?: number }).exitCode).toBe(1);
    expect(tcFail.endTime).toBeTruthy();
    expect(tcFail.error).toContain("boom");
  });

  it("attaches function_call_output arriving after token_count without spawning an empty step", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(200), type: "session_meta", payload: { id: "sess-2" } },
      { timestamp: ts(201), type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: ts(202), type: "response_item", payload: { type: "function_call", name: "exec", call_id: "c1", arguments: "{}" } },
      // token_count closes the step BEFORE the tool output arrives (real Codex ordering)
      { timestamp: ts(203), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 7 } } } },
      { timestamp: ts(204), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "done" } },
      { timestamp: ts(205), type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];

    const { turns } = parseRollout(lines);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    // Only the one step holding the function_call — no empty step from the late output.
    expect(t.steps).toHaveLength(1);
    const tc = t.steps[0]!.toolCalls[0]!;
    expect(tc.callId).toBe("c1");
    expect(tc.output).toBe("done");
    expect(tc.endTime).toBeGreaterThan(tc.startTime);
  });
});

describe("parseRollout custom_tool_call (apply_patch)", () => {
  it("captures apply_patch (custom_tool_call) as a tool with patch enrichment", () => {
    const patch = "*** Begin Patch\n*** Update File: calc.py\n@@\n-    return a-b\n+    return a+b\n*** End Patch\n";
    const lines: RolloutLine[] = [
      { timestamp: ts(0), type: "session_meta", payload: { id: "s1" } },
      { timestamp: ts(1), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { timestamp: ts(2), type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.5" } },
      { timestamp: ts(3), type: "event_msg", payload: { type: "user_message", message: "fix the bug" } },
      { timestamp: ts(4), type: "response_item", payload: { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: patch } },
      { timestamp: ts(5), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p1", output: "Success. Updated calc.py" } },
      { timestamp: ts(6), type: "event_msg", payload: { type: "patch_apply_end", call_id: "p1", status: "completed", success: true } },
      { timestamp: ts(7), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
      { timestamp: ts(8), type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } },
    ];
    const { turns } = parseRollout(lines);
    const tools = turns[0]!.steps.flatMap((s) => s.toolCalls);
    expect(tools).toHaveLength(1);
    const tc = tools[0]!;
    expect(tc.name).toBe("apply_patch");
    expect(tc.args).toBe(patch); // non-JSON input kept as raw string
    expect(tc.output).toBe("Success. Updated calc.py");
    expect(tc.kind).toBe("patch"); // enriched from patch_apply_end
    expect(tc.status).toBe("completed");
    expect(tc.endTime).toBeGreaterThan(tc.startTime);
  });
});

describe("parseRollout spawn_agent (Codex multi-agent v1)", () => {
  it("records a subagent ref from spawn_agent + its function_call_output agent_id", () => {
    const lines: RolloutLine[] = [
      { timestamp: ts(0), type: "session_meta", payload: { id: "parent" } },
      { timestamp: ts(1), type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { timestamp: ts(2), type: "turn_context", payload: { turn_id: "t1", model: "gpt-5.5" } },
      { timestamp: ts(3), type: "response_item", payload: { type: "function_call", call_id: "spawn1", name: "spawn_agent", arguments: "{\"agent_type\":\"worker\",\"message\":\"do x\"}" } },
      { timestamp: ts(4), type: "response_item", payload: { type: "function_call_output", call_id: "spawn1", output: "{\"agent_id\":\"child-thread-9\",\"nickname\":\"Ada\"}" } },
      { timestamp: ts(5), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, output_tokens: 5 } } } },
      { timestamp: ts(6), type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } },
    ];
    const { turns } = parseRollout(lines);
    const turn = turns[0]!;
    // spawn_agent is still a TOOL call (so it gets its own span)...
    const spawnTool = turn.steps.flatMap((s) => s.toolCalls).find((t) => t.name === "spawn_agent");
    expect(spawnTool?.callId).toBe("spawn1");
    // ...and the subagent ref links the child thread to the spawn tool's call id.
    expect(turn.subagents).toEqual([{ threadId: "child-thread-9", spawnCallId: "spawn1" }]);
  });
});
