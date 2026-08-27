// ---- Hook payload (stdin) ----
export type HookInput = {
  session_id?: string;
  turn_id?: string | null;
  transcript_path?: string;
  hook_event_name?: string;
  cwd?: string;
};

// ---- Rollout JSONL records ----
export type SessionMetaPayload = {
  id: string;
  cwd?: string;
  cli_version?: string;
  model_provider?: string | null;
  base_instructions?: { text: string } | null;
  [key: string]: unknown;
};

export type MessageContentPart = { type: string; text?: string; [key: string]: unknown };
export type ResponseItemMessage = { type: "message"; role: string; content: MessageContentPart[] };
export type ResponseItemFunctionCall = { type: "function_call"; name: string; call_id: string; arguments: string };
export type ResponseItemFunctionCallOutput = { type: "function_call_output"; call_id: string; output: unknown };
export type ResponseItemCustomToolCall = { type: "custom_tool_call"; call_id: string; name: string; input: string };
export type ResponseItemCustomToolCallOutput = { type: "custom_tool_call_output"; call_id: string; output: unknown };
export type ResponseItemReasoning = {
  type: "reasoning";
  summary?: unknown[];
  content?: unknown[] | string | null;
  encrypted_content?: string | null;
};
export type ResponseItemOther = { type: string; [key: string]: unknown };
// NOTE: ResponseItem is a proper discriminated union of ONLY the literal-discriminant
// members so `if (p.type === "...")` narrows cleanly. ResponseItemOther is intentionally
// excluded (its `type: string` poisons narrowing). Unknown/other response_item types are
// still handled at runtime: the `as ResponseItem` cast + non-matching if-chain ignores them.
export type ResponseItem =
  | ResponseItemMessage
  | ResponseItemFunctionCall
  | ResponseItemFunctionCallOutput
  | ResponseItemCustomToolCall
  | ResponseItemCustomToolCallOutput
  | ResponseItemReasoning;

export type TurnContextPayload = { turn_id?: string; cwd?: string; model?: string; [key: string]: unknown };

export type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
};

export type EventMsgPayload = {
  type: string;
  turn_id?: string | null;
  call_id?: string;
  message?: string;
  new_thread_id?: string | null;
  started_at?: number;
  completed_at?: number;
  last_agent_message?: string | null;
  info?: { total_token_usage?: TokenUsage; last_token_usage?: TokenUsage; model_context_window?: number } | null;
  /** item_completed */
  item?: { type?: string; content?: MessageContentPart[] } | null;
  // *_end event fields
  status?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  aggregated_output?: string;
  error?: unknown;
  codex_error_info?: unknown;
  [key: string]: unknown;
};

export type RolloutLine =
  | { timestamp: string; type: "session_meta"; payload: SessionMetaPayload }
  | { timestamp: string; type: "response_item"; payload: ResponseItem }
  | { timestamp: string; type: "turn_context"; payload: TurnContextPayload }
  | { timestamp: string; type: "event_msg"; payload: EventMsgPayload }
  | { timestamp: string; type: string; payload: Record<string, unknown> };

// ---- Parsed model ----
export type ToolCall = {
  callId: string;
  name: string;
  args: unknown;
  startTime: number;
  endTime?: number;
  output?: unknown;
  error?: string;
  // enriched from *_end event_msg
  kind?: string;
  status?: string;
  exitCode?: number;
};

export type ModelStep = {
  index: number;
  startTime: number;
  endTime: number;
  reasoning?: string;
  text?: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
};

export type SubagentRef = { threadId: string; spawnCallId?: string };

export type Turn = {
  turnId?: string;
  startTime: number;
  endTime: number;
  model?: string;
  userInput?: string;
  finalOutput?: string;
  steps: ModelStep[];
  /** Subagent spawns captured from spawn_agent / collab_agent_spawn_end. */
  subagents?: SubagentRef[];
  completed: boolean;
  aborted: boolean;
};

export type SessionMeta = {
  sessionId: string;
  cwd?: string;
  cliVersion?: string;
  modelProvider?: string;
  // "user" for a top-level session, "subagent" for a spawned child. A subagent
  // session is emitted nested under its parent's trace, NOT as a standalone trace.
  threadSource?: string;
  parentThreadId?: string;
};
