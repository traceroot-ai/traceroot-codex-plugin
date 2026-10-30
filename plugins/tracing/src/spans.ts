import { ROOT_CONTEXT, type SpanContext, SpanKind, TraceFlags, trace } from "@opentelemetry/api";
import type { Tracing } from "./exporter.js";
import { makeSpanId, makeTraceId } from "./ids.js";
import { capWithImages, fitSpanImages, replaceImages } from "./images.js";
import { SDK_NAME, SDK_VERSION } from "./sdk.js";
import { mapUsage } from "./tokens.js";
import type { ModelStep, SessionMeta, ToolCall, Turn } from "./types.js";
import { truncate } from "./util.js";

// The trace title. Used as the root span name AND as path[0] on every span so
// the trace reads as "Codex Turn" even before the root span exists (see below).
export const ROOT_NAME = "Codex Turn";

export type EmitCtx = {
  environment?: string;
  userId?: string;
  git?: { repo?: string; ref?: string };
  maxChars: number;
  // True only on the terminal Stop hook (the turn is ending). The root span is
  // emitted only when the turn ends, so a still-running turn has NO completed
  // root in ClickHouse — which is how the backend's live-stream detector knows
  // the trace is in progress and keeps streaming (matching the SDK's model).
  turnEnding?: boolean;
  // Keep image data URLs in tool output and prompts whole instead of cutting
  // them at maxChars (off by default).
  captureImages?: boolean;
};

type SpanAttrs = Record<string, string | number | string[]>;

export type EmittableSpan = {
  spanId: string;
  parentSpanId: string | null;
  traceId: string;
  kind: "AGENT" | "LLM" | "TOOL";
  name: string;
  startTime: number;
  endTime: number;
  attributes: SpanAttrs;
  complete: boolean;
};

const str = (v: unknown, max: number): string =>
  truncate(typeof v === "string" ? v : JSON.stringify(v ?? ""), max);

/** Span input/output capped at maxChars; with image capture on, images stay whole. */
const io = (v: unknown, ctx: EmitCtx): string =>
  ctx.captureImages ? capWithImages(v, ctx.maxChars) : str(v, ctx.maxChars);

/** The prompt as the model got it: its text, plus attached images when image capture is on. */
function promptOf(turn: Turn, ctx: EmitCtx): unknown {
  if (!ctx.captureImages || !turn.userImages?.length) return turn.userInput;
  return [
    ...(turn.userInput ? [{ type: "input_text", text: turn.userInput }] : []),
    ...turn.userImages.map((url) => ({ type: "input_image", image_url: url })),
  ];
}

/**
 * A tool's output as the next model call is shown it. With image capture on, each
 * image points at the tool span that already holds it instead of being sent twice.
 */
const fedBackOutput = (tc: ToolCall, ctx: EmitCtx): unknown =>
  ctx.captureImages ? replaceImages(tc.output, `[image: see tool call ${tc.callId}]`) : tc.output;

function commonTrace(attrs: SpanAttrs, sessionMeta: SessionMeta, ctx: EmitCtx): void {
  attrs["traceroot.sdk.name"] = SDK_NAME;
  attrs["traceroot.sdk.version"] = SDK_VERSION;
  // Child subagent spans intentionally carry the CHILD session id here (sessionMeta is
  // the child's own SessionMeta). The trace still groups correctly because the backend
  // keys a trace's session off the ROOT (parent) span, not the children. A future
  // `overrideSessionId` field on PlanOpts would be the clean way to force the parent's
  // session id onto child spans if grouping ever needs it — not implemented now.
  attrs["traceroot.trace.session_id"] = sessionMeta.sessionId;
  if (ctx.userId) attrs["traceroot.trace.user_id"] = ctx.userId;
  if (ctx.environment) attrs["traceroot.environment"] = ctx.environment;
}

export type PlanOpts = {
  traceId?: string;
  rootParentSpanId?: string | null;
  seedPrefix?: string;
};

export function planTurnSpans(sessionMeta: SessionMeta, turn: Turn, ctx: EmitCtx, opts?: PlanOpts): EmittableSpan[] {
  if (!turn.turnId) return [];
  // When opts is undefined, seed="" so every id is byte-identical to the pre-opts baseline.
  const seed = opts?.seedPrefix ?? "";
  const traceId = opts?.traceId ?? makeTraceId(sessionMeta.sessionId, turn.turnId);
  const rootId = makeSpanId(seed + turn.turnId + ":root");
  const rootParentSpanId = opts?.rootParentSpanId !== undefined ? opts.rootParentSpanId : null;
  const out: EmittableSpan[] = [];

  // Root AGENT span (trace-level attrs live here).
  const rootAttrs: SpanAttrs = { "traceroot.span.type": "AGENT", "traceroot.span.path": [ROOT_NAME] };
  commonTrace(rootAttrs, sessionMeta, ctx);
  const prompt = promptOf(turn, ctx);
  if (prompt) rootAttrs["traceroot.span.input"] = io(prompt, ctx);
  if (turn.finalOutput) rootAttrs["traceroot.span.output"] = str(turn.finalOutput, ctx.maxChars);
  rootAttrs["traceroot.span.metadata"] = JSON.stringify(pruneUndefined({
    "codex.turn_id": turn.turnId,
    "codex.thread_id": sessionMeta.sessionId,
    "codex.model": turn.model,
    "codex.model_provider": sessionMeta.modelProvider,
    "codex.cli_version": sessionMeta.cliVersion,
    "codex.tool_call_count": turn.steps.reduce((n, s) => n + s.toolCalls.length, 0),
  }));
  if (ctx.git?.repo) rootAttrs["traceroot.git.repo"] = ctx.git.repo;
  if (ctx.git?.ref) rootAttrs["traceroot.git.ref"] = ctx.git.ref;
  // Root end = the latest activity in the turn, not just the task_complete time.
  // turn.endTime only advances on task_complete, so a turn that was aborted or
  // snapshotted live (no task_complete) would have endTime === startTime and
  // render as a 0ms bar. Cover the turn's own steps and tool calls (including
  // wait_agent, which ends when a spawned subagent finishes) so the root always
  // spans its children — and grows correctly across live hooks.
  let rootEnd = turn.endTime;
  for (const step of turn.steps) {
    if (step.endTime > rootEnd) rootEnd = step.endTime;
    for (const tc of step.toolCalls) {
      if (tc.endTime !== undefined && tc.endTime > rootEnd) rootEnd = tc.endTime;
    }
  }
  out.push({
    spanId: rootId, parentSpanId: rootParentSpanId, traceId, kind: "AGENT",
    name: ROOT_NAME, startTime: turn.startTime, endTime: rootEnd,
    attributes: rootAttrs,
    // The root is emitted only when the turn ENDS (task_complete, or the terminal
    // Stop hook signalled via ctx.turnEnding) — never mid-turn. A completed root in
    // ClickHouse is the backend's "trace is done" signal, so emitting it early would
    // close the live SSE stream on the first hook (the trace would look finished and
    // stop updating until refresh). Deferring it keeps the trace live while the turn
    // runs; meanwhile traceroot.span.path keeps the title "Codex Turn". Subagent roots
    // (rootParentSpanId !== null) stay gated on their own completion.
    complete: rootParentSpanId === null ? (turn.completed || !!ctx.turnEnding) : turn.completed,
  });

  // LLM-step input is the user prompt (first step) or the prior step's tool
  // results fed back to the model (continuation steps) — like the conversation
  // the model actually saw.
  let prevToolResults: string | undefined;
  for (const step of turn.steps) {
    const stepId = makeSpanId(seed + turn.turnId + ":step:" + step.index);
    const input = step.index === 0 ? prompt : prevToolResults;
    out.push(planStepSpan(sessionMeta, turn, step, stepId, rootId, traceId, ctx, input));
    for (const tc of step.toolCalls) out.push(planToolSpan(sessionMeta, tc, seed, stepId, traceId, ctx));
    if (step.toolCalls.length) {
      prevToolResults = str(
        step.toolCalls.map((tc) => ({ name: tc.name, output: fedBackOutput(tc, ctx) })), ctx.maxChars,
      );
    }
  }
  // Images are kept whole, so a span can grow past what the backend stores;
  // trade its largest images for placeholders until it fits.
  if (ctx.captureImages) for (const span of out) fitSpanImages(span.attributes);
  return out;
}

function pruneUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) r[k] = v;
  return r;
}

/** LLM-step output: text + reasoning + the tool calls the model requested. */
function buildStepOutput(step: ModelStep, max: number): string | undefined {
  const o: Record<string, unknown> = {};
  if (step.text) o.content = step.text;
  if (step.reasoning) o.reasoning = step.reasoning;
  if (step.toolCalls.length) o.tool_calls = step.toolCalls.map((tc) => ({ name: tc.name, args: tc.args }));
  if (Object.keys(o).length === 0) return undefined;
  return truncate(JSON.stringify(o), max);
}

function planStepSpan(
  sessionMeta: SessionMeta, turn: Turn, step: ModelStep,
  spanId: string, parentSpanId: string, traceId: string, ctx: EmitCtx, input: unknown,
): EmittableSpan {
  const attrs: SpanAttrs = {
    "traceroot.span.type": "LLM",
    // path[0] = ROOT_NAME so the trace title stays "Codex Turn" while the root
    // span is still deferred (the backend names the trace from the shallowest
    // span's path[0] until the real root arrives).
    "traceroot.span.path": [ROOT_NAME, turn.model ?? "model"],
  };
  commonTrace(attrs, sessionMeta, ctx);
  if (turn.model) attrs["traceroot.llm.model"] = turn.model;
  if (input) attrs["traceroot.span.input"] = io(input, ctx);
  const output = buildStepOutput(step, ctx.maxChars);
  if (output) attrs["traceroot.span.output"] = output;
  attrs["traceroot.span.metadata"] = JSON.stringify({ "codex.step_index": step.index });
  Object.assign(attrs, mapUsage(step.usage));
  return {
    spanId, parentSpanId, traceId, kind: "LLM",
    name: turn.model ?? "model", startTime: step.startTime, endTime: step.endTime,
    attributes: attrs, complete: Boolean(step.usage),
  };
}

function planToolSpan(
  sessionMeta: SessionMeta, tc: ToolCall, seed: string, parentSpanId: string, traceId: string, ctx: EmitCtx,
): EmittableSpan {
  const attrs: SpanAttrs = {
    "traceroot.span.type": "TOOL",
    "traceroot.span.path": [ROOT_NAME, tc.name],
  };
  commonTrace(attrs, sessionMeta, ctx);
  attrs["traceroot.span.input"] = str(tc.args, ctx.maxChars);
  if (tc.output !== undefined) attrs["traceroot.span.output"] = io(tc.output, ctx);
  const meta: Record<string, unknown> = {};
  if (tc.kind !== undefined) meta["tool_kind"] = tc.kind;
  if (tc.status !== undefined) meta["status"] = tc.status;
  if (tc.exitCode !== undefined) meta["exit_code"] = tc.exitCode;
  if (tc.error !== undefined) meta["error"] = tc.error;
  if (Object.keys(meta).length > 0) attrs["traceroot.span.metadata"] = JSON.stringify(meta);
  return {
    spanId: makeSpanId(seed + tc.callId), parentSpanId, traceId, kind: "TOOL",
    name: tc.name, startTime: tc.startTime, endTime: tc.endTime ?? tc.startTime,
    attributes: attrs, complete: tc.endTime !== undefined,
  };
}

const KIND: Record<EmittableSpan["kind"], SpanKind> = {
  AGENT: SpanKind.INTERNAL, LLM: SpanKind.CLIENT, TOOL: SpanKind.INTERNAL,
};

export function emitSpan(tracing: Tracing, s: EmittableSpan): void {
  let ctx = ROOT_CONTEXT;
  if (s.parentSpanId) {
    const parent: SpanContext = {
      traceId: s.traceId, spanId: s.parentSpanId, traceFlags: TraceFlags.SAMPLED, isRemote: false,
    };
    ctx = trace.setSpanContext(ROOT_CONTEXT, parent);
  } else {
    tracing.idGen.nextTraceId = s.traceId;
  }
  tracing.idGen.nextSpanId = s.spanId;
  const span = tracing.tracer.startSpan(
    s.name, { startTime: s.startTime, kind: KIND[s.kind], attributes: s.attributes }, ctx,
  );
  span.end(s.endTime);
}
