import * as fs from "node:fs/promises";
import type {
  EventMsgPayload, ModelStep, ResponseItem, RolloutLine, SessionMeta, SubagentRef, ToolCall, Turn, TurnContextPayload,
} from "./types.js";

export async function readRollout(file: string): Promise<RolloutLine[]> {
  const raw = await fs.readFile(file, "utf-8");
  const lines: RolloutLine[] = [];
  for (const ln of raw.split("\n")) {
    const trimmed = ln.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RolloutLine);
    } catch {
      // skip malformed line, keep going
    }
  }
  return lines;
}

const ms = (ts: string): number => Date.parse(ts);

function toolKindFromEndEvent(eventType: string): string {
  if (eventType === "exec_command_end") return "exec";
  if (eventType === "patch_apply_end") return "patch";
  if (eventType === "mcp_tool_call_end") return "mcp";
  if (eventType === "collab_agent_spawn_end") return "spawn";
  if (eventType === "custom_tool_call_end") return "custom";
  if (eventType === "web_search_end" || eventType === "tool_search_call_end") return "search";
  return "unknown";
}

function extractToolError(p: EventMsgPayload): string | undefined {
  if (p.error != null || p.codex_error_info != null) {
    return JSON.stringify(p.error ?? p.codex_error_info);
  }
  const parts = ([p.stdout, p.stderr] as Array<string | undefined>).filter(Boolean) as string[];
  if (parts.length) return parts.join("\n");
  if (p.aggregated_output != null) return p.aggregated_output;
  if (typeof p.exit_code === "number") return `Exit code: ${p.exit_code}`;
  return undefined;
}

function reasoningText(p: { summary?: unknown[]; content?: unknown }): string | undefined {
  const parts: string[] = [];
  for (const s of (p.summary ?? []) as Array<{ text?: string }>) if (s?.text) parts.push(s.text);
  if (typeof p.content === "string") parts.push(p.content);
  return parts.length ? parts.join("\n") : undefined;
}

function messageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = (content as Array<{ text?: string }>)
    .filter((c) => typeof c?.text === "string")
    .map((c) => c.text as string);
  return parts.length ? parts.join("") : undefined;
}

// Codex and plugins reuse role:"user" for synthetic context blocks. These can
// appear before or after the real prompt and must not become trace input. This
// denylist is best-effort: third-party plugins may introduce new wrapper tags.
const INJECTED_USER_MESSAGE_TAGS = new Set([
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
]);

function isInjectedUserMessage(text: string): boolean {
  const tag = /^<([A-Za-z0-9_-]+)\b/.exec(text.trimStart())?.[1];
  return tag !== undefined && INJECTED_USER_MESSAGE_TAGS.has(tag);
}

function isInjectedFallbackText(text: string): boolean {
  if (isInjectedUserMessage(text)) return true;
  if (/^# AGENTS\.md instructions for\b/.test(text.trim())) return true;
  // Modern Codex can fuse a preamble and injected context into one user-role
  // response item, so inspect structural wrapper lines anywhere in the text.
  // Inline mentions remain valid fallback prompts.
  return /(?:^|\n)[ \t]*<\/?(environment_context|user_instructions)\b/.test(text);
}

/** Codex's spawn_agent tool returns {"agent_id":"<thread id>","nickname":"..."}. */
function parseSpawnAgentId(output: unknown): string | undefined {
  let obj: unknown = output;
  if (typeof output === "string") {
    try { obj = JSON.parse(output); } catch { return undefined; }
  }
  const id = (obj as { agent_id?: unknown } | null)?.agent_id;
  return typeof id === "string" && id ? id : undefined;
}

export function parseRollout(lines: RolloutLine[]): { sessionMeta: SessionMeta; turns: Turn[] } {
  let sessionMeta: SessionMeta = { sessionId: "" };
  const turns: Turn[] = [];
  let turn: Turn | undefined;
  let step: ModelStep | undefined;
  const toolsByCallId = new Map<string, ToolCall>();
  const userInputFallback = new Map<Turn, string>();
  const authoritativeUserInputs = new Map<Turn, Set<string>>();
  // call_ids of spawn_agent tool calls, so we can read the child thread id from
  // the matching function_call_output ({"agent_id": "..."}).
  const spawnAgentCallIds = new Set<string>();

  const ensureStep = (t: Turn, at: number): ModelStep => {
    if (!step) {
      step = { index: t.steps.length, startTime: at, endTime: at, toolCalls: [], reasoning: undefined, text: undefined };
      t.steps.push(step);
    }
    return step;
  };

  const appendAuthoritativeUserInput = (t: Turn, text: string): void => {
    let inputs = authoritativeUserInputs.get(t);
    if (!inputs) {
      inputs = new Set<string>();
      authoritativeUserInputs.set(t, inputs);
    }
    if (inputs.has(text)) return;
    inputs.add(text);
    t.userInput = [...inputs].join("\n\n");
  };

  for (const line of lines) {
    const at = ms(line.timestamp);
    if (line.type === "session_meta") {
      sessionMeta = {
        sessionId: (line.payload as { id: string }).id,
        cwd: (line.payload as { cwd?: string }).cwd,
        cliVersion: (line.payload as { cli_version?: string }).cli_version,
        modelProvider: (line.payload as { model_provider?: string }).model_provider ?? undefined,
        threadSource: (line.payload as { thread_source?: string }).thread_source,
        parentThreadId: (line.payload as { parent_thread_id?: string }).parent_thread_id,
      };
      continue;
    }

    if (line.type === "turn_context") {
      const p = line.payload as TurnContextPayload;
      if (turn && p.model) turn.model = p.model;
      continue;
    }

    if (line.type === "event_msg") {
      const p = line.payload as EventMsgPayload;
      switch (p.type) {
        case "task_started":
          turn = {
            turnId: p.turn_id ?? undefined, startTime: at, endTime: at,
            steps: [], subagents: [], completed: false, aborted: false,
          };
          step = undefined;
          toolsByCallId.clear();
          spawnAgentCallIds.clear();
          turns.push(turn);
          break;
        case "user_message":
          if (turn && typeof p.message === "string" && !isInjectedUserMessage(p.message)) {
            appendAuthoritativeUserInput(turn, p.message);
          }
          break;
        case "item_completed":
          if (turn && p.item?.type === "UserMessage") {
            // Current Codex versions emit the bare prompt in this structured
            // event. It is authoritative; response_item/user is only fallback.
            const text = messageText(p.item.content);
            if (text) appendAuthoritativeUserInput(turn, text);
          }
          break;
        case "agent_message":
          // Older Codex versions emit this before task_complete. Keep it as a
          // provisional final output for live reads; newer versions use the
          // assistant response_item path handled below. Last one wins.
          if (turn && typeof p.message === "string") turn.finalOutput = p.message;
          break;
        case "token_count":
          if (turn && p.info?.last_token_usage) {
            const s = ensureStep(turn, at);
            s.usage = p.info.last_token_usage;
            s.endTime = at;
            step = undefined; // close current step
          }
          break;
        case "task_complete":
          if (turn) {
            turn.completed = true;
            turn.endTime = at;
            const lastText = [...turn.steps].reverse().find((s) => s.text)?.text;
            // Prefer an explicit last_agent_message; otherwise keep what the
            // live message events already captured, then fall back to step text.
            turn.finalOutput = (p.last_agent_message ?? turn.finalOutput ?? lastText) ?? undefined;
          }
          break;
        default:
          if (turn && typeof p.new_thread_id === "string") {
            const ref: SubagentRef = { threadId: p.new_thread_id };
            if (typeof p.call_id === "string") ref.spawnCallId = p.call_id;
            (turn.subagents ??= []).push(ref);
          }
          if (turn && p.type.endsWith("_end") && typeof p.call_id === "string") {
            const tc = toolsByCallId.get(p.call_id);
            if (tc) {
              tc.kind = toolKindFromEndEvent(p.type);
              if (typeof p.status === "string") tc.status = p.status;
              if (typeof p.exit_code === "number") tc.exitCode = p.exit_code;
              if (!tc.endTime) tc.endTime = at;
              if (tc.output === undefined) tc.output = p.aggregated_output ?? p.stdout;
              if (p.status === "failed" || p.status === "declined") tc.error = extractToolError(p);
            }
          }
      }
      continue;
    }

    if (line.type === "response_item" && turn) {
      const p = line.payload as ResponseItem;
      if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        // Tool output can arrive after token_count closed the step; never open a new
        // step for it — just attach to the toolCall recorded in its original step.
        const tc = toolsByCallId.get(p.call_id);
        if (tc) { tc.endTime = at; tc.output = p.output; }
        // spawn_agent's output carries the child thread id: {"agent_id":"...."}.
        // Record it (with the spawn tool's call_id) so the subagent's spans nest
        // under this spawn_agent TOOL span, in the same trace.
        if (turn && spawnAgentCallIds.has(p.call_id)) {
          const threadId = parseSpawnAgentId(p.output);
          if (threadId) (turn.subagents ??= []).push({ threadId, spawnCallId: p.call_id });
        }
        continue;
      }
      const s = ensureStep(turn, at);
      if (p.type === "reasoning") {
        s.reasoning = reasoningText(p);
      } else if (p.type === "message") {
        const text = messageText(p.content);
        if (p.role === "user") {
          // Some Codex versions expose the prompt only as a response item. Keep
          // the first plausible prompt as fallback, but never let it shadow the
          // clean user_message or item_completed/UserMessage representation.
          if (text && !isInjectedFallbackText(text) && !userInputFallback.has(turn)) {
            userInputFallback.set(turn, text);
          }
        } else if (p.role !== "developer") {
          s.text = text;
          // Newer Codex versions may fire the Stop hook after the final assistant
          // response_item but before task_complete, without an agent_message event.
          // Treat the latest non-empty assistant message as provisional final
          // output so the root span is complete in that live-read window.
          if (p.role === "assistant" && text) turn.finalOutput = text;
        }
      } else if (p.type === "function_call") {
        let args: unknown = p.arguments;
        try { args = JSON.parse(p.arguments); } catch { /* keep string */ }
        const tc: ToolCall = { callId: p.call_id, name: p.name, args, startTime: at };
        s.toolCalls.push(tc);
        toolsByCallId.set(p.call_id, tc);
        // Codex multi-agent v1: spawn_agent launches a subagent; its child thread
        // id arrives in the matching function_call_output.
        if (p.name === "spawn_agent") spawnAgentCallIds.add(p.call_id);
      } else if (p.type === "custom_tool_call") {
        // Codex emits some tools (e.g. apply_patch) as custom_tool_call with the
        // payload in `input` (often non-JSON text, e.g. a patch). Treat it as a tool.
        let args: unknown = p.input;
        try { args = JSON.parse(p.input); } catch { /* keep raw string */ }
        const tc: ToolCall = { callId: p.call_id, name: p.name, args, startTime: at };
        s.toolCalls.push(tc);
        toolsByCallId.set(p.call_id, tc);
      }
      continue;
    }
  }

  // Resolve fallbacks after parsing so authoritative events win regardless of
  // file order while incomplete turns remain usable by a live Stop hook.
  for (const t of turns) t.userInput ??= userInputFallback.get(t);

  return { sessionMeta, turns };
}
